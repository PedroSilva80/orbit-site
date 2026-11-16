// Orbit - leitor de noticias (roda no GitHub Actions do repo publico orbit-site). Node 20+, sem dependencias.
// Variaveis: NTFY_TOPIC (segredo), FORCE=1 (envia aviso de teste), NEWS_BASE / NTFY_BASE (testes).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const NEWS = process.env.NEWS_BASE || 'https://news.google.com';
const NTFY = process.env.NTFY_BASE || 'https://ntfy.sh';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';

const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dec = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

// categoria, peso, padrao (texto sem acento, minusculo)
const REGRAS = [
  ['IPO', 6, /\bipo\b|\bipos\b|oferta publica inicial|abertura de capital|estreia na bolsa|\bs-1\b|go(es|ing)? public|direct listing|precifica(r|ção)? .*oferta/],
  ['Liderança', 5, /renunci|deixa (o )?comando|demite|demissao d|steps? down|resign|ousted|ceo exit|novo ceo|new ceo|afastad[oa] d/],
  ['Risco grave', 5, /fraude|fraud|investigac|investigation|investiga |recuperacao judicial|falencia|bankrupt|chapter 11|calote|\bdefault\b|multa bilion|sec (charges|sues)|ciberataque|cyberattack|vazamento de dados|data breach|recall/],
  ['Resultado', 4, /balanco|resultado d[oe] (1|2|3|4|primeiro|segundo|terceiro|quarto)|resultados? trimestra|earnings|quarterly results|guidance|\blucro\b|prejuizo/],
  ['Corporativo', 4, /aquisicao|acquir|acquisition|\bfusao\b|merger|takeover|oferta de compra|spin-off|stock split|desdobramento|recompra|buyback|dividendos? extraordinari/],
  ['Lançamento', 3, /lancamento|launch|release date|gta vi|gta 6|adiad[oa]|delayed|\bdelay\b/],
  ['Regulação', 3, /regulacao|regulat|antitruste|antitrust|\btarifa|tariff|sancoes|sanctions|proibe|\bban\b|\bban(s|ned)\b/],
  ['Mercado', 3, /copom|\bselic\b|taxa de juros|interest rate|\bfed\b|inflacao|\bipca\b|\bcpi\b|recessao|crash|circuit breaker|\bguerra\b|\bwar\b|petroleo|\bopec\b/],
  ['Movimento', 2, /despenca|desaba|dispara|plunge|plummet|\bsoars?\b|tumble|surge|recorde|record high/]
];

export function pontuar(titulo, empresas = []) {
  const t = sem(titulo);
  const cats = [];
  REGRAS.forEach(([c, w, re]) => { if (re.test(t)) cats.push([c, w]); });
  if (!cats.length) return { score: 0, cat: '', empresa: '' };
  cats.sort((a, b) => b[1] - a[1]);
  let score = cats[0][1] + Math.min(2, cats.length - 1);
  let empresa = '';
  for (const e of empresas) { const re = new RegExp('(^|[^a-z0-9])' + sem(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)'); if (re.test(t)) { empresa = e; break; } }
  if (empresa) score += 3;
  if (/bilh|billion|trilh|trillion/.test(t)) score += 1;
  return { score, cat: cats[0][0], empresa };
}

export function parseRss(xml) {
  const out = [];
  const itens = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of itens) {
    const g = tag => { const m = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return m ? dec(m[1]) : ''; };
    let titulo = g('title'), fonte = g('source');
    if (fonte && titulo.endsWith(' - ' + fonte)) titulo = titulo.slice(0, -(fonte.length + 3));
    else if (!fonte) { const k = titulo.lastIndexOf(' - '); if (k > 20) { fonte = titulo.slice(k + 3); titulo = titulo.slice(0, k); } }
    const d = new Date(g('pubDate'));
    if (!titulo || isNaN(d)) continue;
    out.push({ titulo, fonte: fonte || 'Notícia', link: g('link'), data: d.toISOString() });
  }
  return out;
}

const STOP = new Set(['para', 'com', 'que', 'dos', 'das', 'uma', 'por', 'the', 'and', 'for', 'with', 'from', 'after', 'nas', 'nos', 'sobre']);
const toks = s => new Set(sem(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
export function parecidas(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return false;
  let i = 0; A.forEach(w => { if (B.has(w)) i++; });
  return i / (A.size + B.size - i) >= 0.55;
}
const idDe = s => { let h = 0; const t = sem(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h.toString(36); };

export function consultas(cfg) {
  const q = [];
  const chunk = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
  chunk(cfg.empresasBR || [], 6).forEach(g => q.push({ q: g.map(x => '"' + x + '"').join(' OR '), lang: 'pt' }));
  chunk(cfg.empresasUS || [], 6).forEach(g => q.push({ q: g.map(x => '"' + x + '"').join(' OR '), lang: 'en' }));
  (cfg.termos || []).forEach(t => q.push(typeof t === 'string' ? { q: t, lang: 'pt' } : t));
  return q;
}
async function buscar(c) {
  const pt = c.lang !== 'en';
  const url = `${NEWS}/rss/search?q=${encodeURIComponent(c.q + ' when:1d')}&` + (pt ? 'hl=pt-BR&gl=BR&ceid=BR:pt-419' : 'hl=en-US&gl=US&ceid=US:en');
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 orbit-noticias' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return parseRss(await r.text());
}
async function ntfy(topic, titulo, msg, link, prio = 3) {
  const body = { topic, title: titulo, message: msg, priority: prio, tags: ['newspaper'] };
  if (link) body.click = link;
  const r = await fetch(NTFY, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('ntfy ' + r.status);
}
function lerJson(f, pad) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return pad; } }

export async function main(dir = '.') {
  const cfg = { limiarAviso: 7, maxPorRodada: 3, maxPorDia: 8, horaInicio: 7, horaFim: 23, ...lerJson(`${dir}/noticias-config.json`, {}) };
  const empresas = [...(cfg.empresasBR || []), ...(cfg.empresasUS || []), ...(cfg.destaques || [])];
  const topic = (process.env.NTFY_TOPIC || '').trim();
  const arq = `${dir}/news.json`;
  const base = lerJson(arq, { atualizado: '', itens: [] });
  const agora = Date.now();
  let itens = (base.itens || []).filter(x => agora - Date.parse(x.data) < 72 * 36e5);
  let falhas = 0; const qs = consultas(cfg); let novas = 0;
  for (const c of qs) {
    let lista = [];
    try { lista = await buscar(c); } catch (e) { falhas++; console.log('Falha na busca:', c.q.slice(0, 40), e.message); continue; }
    for (const n of lista) {
      if (agora - Date.parse(n.data) > 30 * 36e5 || Date.parse(n.data) > agora + 36e5) continue;
      const p = pontuar(n.titulo, empresas);
      if (p.score < 4) continue;
      const id = idDe(n.titulo);
      if (itens.some(x => x.id === id || parecidas(x.titulo, n.titulo))) continue;
      itens.push({ id, titulo: n.titulo, fonte: n.fonte, link: n.link, data: n.data, cat: p.cat, empresa: p.empresa, score: p.score, avisado: false });
      novas++;
    }
  }
  itens.sort((a, b) => Date.parse(b.data) - Date.parse(a.data));
  itens = itens.slice(0, 150);

  // avisos
  const h = new Date(agora - 3 * 36e5).getUTCHours();
  const janela = FORCE || (h >= cfg.horaInicio && h < cfg.horaFim);
  let enviados = 0, errNtfy = 0;
  if (!topic) console.log('NTFY_TOPIC vazio: sem avisos.');
  if (topic && janela) {
    const hoje = itens.filter(x => x.avisadoEm && agora - x.avisadoEm < 864e5).length;
    const elegiveis = itens.filter(x => !x.avisado && agora - Date.parse(x.data) < 12 * 36e5 && (x.score >= cfg.limiarAviso || (x.cat === 'IPO' && x.score >= 6)))
      .sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(cfg.maxPorRodada, cfg.maxPorDia - hoje)));
    if (FORCE) { try { await ntfy(topic, 'Notícias do Orbit funcionando', `Teste ok. ${itens.length} notícia(s) na lista, ${elegiveis.length} para avisar agora.` + (falhas ? ` ${falhas} busca(s) falharam.` : ''), '', 3); enviados++; } catch (e) { errNtfy++; console.log('Falha no teste:', e.message); } }
    for (const x of elegiveis) {
      try { await ntfy(topic, `${x.cat}${x.empresa ? ' · ' + x.empresa : ''}`, `${x.titulo} (${x.fonte})`, x.link, x.score >= 9 ? 4 : 3); x.avisado = true; x.avisadoEm = agora; enviados++; }
      catch (e) { errNtfy++; console.log('Falha ao avisar:', e.message); }
    }
  }
  const mudou = JSON.stringify(itens) !== JSON.stringify(base.itens || []);
  if (mudou) fs.writeFileSync(arq, JSON.stringify({ atualizado: new Date(agora).toISOString(), itens }, null, 1) + '\n');
  console.log(`Buscas: ${qs.length - falhas}/${qs.length}. Novas: ${novas}. Avisos: ${enviados}.`);
  if (qs.length && falhas === qs.length) return 1;
  return errNtfy ? 1 : 0;
}

if (!process.env.ORBIT_NO_RUN && process.argv[1] === fileURLToPath(import.meta.url)) main('.').then(c => process.exit(c));
