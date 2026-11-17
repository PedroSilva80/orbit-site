// Orbit - leitor de noticias e agenda (roda no GitHub Actions do repo publico orbit-site). Node 20+, sem dependencias.
// Variaveis: NTFY_TOPIC (segredo), FORCE=1 (envia aviso de teste), NEWS_BASE / NTFY_BASE / CAL_BASE / ORBIT_NOW (testes).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const NEWS = process.env.NEWS_BASE || 'https://news.google.com';
const NTFY = process.env.NTFY_BASE || 'https://ntfy.sh';
const CAL = process.env.CAL_BASE || 'https://api.nasdaq.com';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const AGORA = () => (process.env.ORBIT_NOW ? +process.env.ORBIT_NOW : Date.now());

const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dec = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- datas no horario de Brasilia ----------
export const diaBR = ms => new Date(ms - 3 * 36e5).toISOString().slice(0, 10);
export const somaDias = (dia, k) => new Date(Date.parse(dia + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const semana = dia => new Date(dia + 'T12:00:00Z').getUTCDay();
const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const DIAS_TXT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// ---------- notas das noticias ----------
// categoria, peso, padrao (texto sem acento, minusculo)
const REGRAS = [
  ['IPO', 6, /\bipos?\b|oferta publica inicial|abertura de capital|estreia na bolsa|estreia na nasdaq|estreia em nova york|pedido de listagem|\bgo(es|ing)? public\b/],
  ['Liderança', 5, /\bex-?ceo\b|volt(a|ar|e|ou|aria|ara) ao comando|retorno (de|do|da) [a-z]+ (huang|ao comando)|reconduz|\brenunci|deixa (o )?(comando|cargo)|\bdemite\b|demissao d[oa] (ceo|presidente)|novo (ceo|presidente)|nova (ceo|presidente)|afastad[oa] d[oa] (cargo|comando)/],
  ['Risco grave', 5, /\bfraude|investigac|investiga |recuperacao judicial|falencia|\bcalote|\bdefault\b|multa bilion|ciberataque|ataque hacker|vazamento de dados|\brecall\b|rombo/],
  ['Resultado', 4, /\bbalanco\b|resultados? (do|de) (1|2|3|4)\s?t|resultados? trimestra|\blucro\b|\bprejuizo\b|\bguidance\b|receita recorde/],
  ['Corporativo', 4, /\baquisicao|\bcompra (a|o|da|do) |\bfusao\b|oferta (de compra|hostil)|\bopa\b|spin-?off|\bcisao\b|desdobramento|grupamento|recompra de acoes|dividendos? extraordinari/],
  ['Lançamento', 3, /\blancamento\b|\blanca\b|data de lancamento|\badiad[oa]\b|\badiamento\b|gta vi|gta 6/],
  ['Regulação', 3, /\bregulacao|antitruste|\bcade\b|\btarifa|\bsancoes|\bproibe\b|\bbanimento\b|\bcvm\b/],
  ['Mercado', 3, /\bcopom\b|\bselic\b|taxa de juros|\bfed\b|\bfomc\b|\binflacao\b|\bipca\b|\brecessao\b|circuit breaker|\bguerra\b|petroleo|\bopep\b/],
  ['Movimento', 2, /\bdespenca|\bdesaba|\bdispara|\bderrete|\bsalta\b|\brecorde\b|maior (alta|queda)/]
];
// Noticia de IPO de empresa que JA esta na bolsa so vale se for de uma subsidiaria/controlada.
const IPO_SUB = /subsidiaria|controlada|unidade|braco|\bspin|\bcisao|separa/;
// Marcos que liberam um novo aviso do mesmo assunto antes do prazo de 48h.
const MARCO = /\bestreia|\bestreou|precific|define (o )?preco|faixa de preco|\bdata\b|\badiad|\bsuspen|\bcancel|\baprovad|\bregistro|\brenunci|recuperacao judicial|falencia/;

export function pontuar(titulo, empresas = [], listadas = []) {
  const t = sem(titulo);
  let cats = [];
  REGRAS.forEach(([c, w, re]) => { if (re.test(t)) cats.push([c, w]); });
  const acha = lista => achaEmpresa(t, lista);
  const empresa = acha(empresas);
  if (cats.some(c => c[0] === 'IPO') && acha(listadas) && !IPO_SUB.test(t)) cats = cats.filter(c => c[0] !== 'IPO');
  if (!cats.length) return { score: 0, cat: '', empresa };
  cats.sort((a, b) => b[1] - a[1]);
  let score = cats[0][1] + Math.min(2, cats.length - 1);
  if (empresa) score += 3;
  if (/bilh|trilh/.test(t)) score += 1;
  return { score, cat: cats[0][0], empresa, marco: MARCO.test(t) };
}

// Empresa citada primeiro no titulo (ex.: "GTA VI chega... acoes da Take-Two" -> GTA VI).
export function achaEmpresa(t, lista) {
  let melhor = '', pos = 1e9;
  for (const e of lista) { const m = new RegExp('(^|[^a-z0-9])' + esc(sem(e)) + '([^a-z0-9]|$)').exec(t); if (m && m.index < pos) { pos = m.index; melhor = e; } }
  return melhor;
}

// ---------- titulos em ingles ----------
const EN = new Set(['the', 'of', 'to', 'in', 'for', 'on', 'with', 'as', 'is', 'at', 'after', 'says', 'said', 'stock', 'stocks', 'shares', 'its', 'and', 'by', 'from', 'will', 'new', 'amid', 'over', 'how', 'why', 'what', 'could', 'may']);
const PT = new Set(['de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos', 'com', 'para', 'por', 'que', 'uma', 'um', 'ao', 'aos', 'se', 'mais', 'apos', 'sobre', 'sera', 'tem', 'foi', 'vai', 'diz']);
export function ingles(titulo) {
  const w = sem(titulo).replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  let en = 0, pt = 0; w.forEach(x => { if (EN.has(x)) en++; if (PT.has(x)) pt++; });
  return en >= 2 && en > pt;
}

// ---------- agenda: eventos futuros lidos das manchetes ----------
export function extrairData(titulo, pubMs) {
  const t = sem(titulo), base = diaBR(pubMs), y = +base.slice(0, 4), mo = +base.slice(5, 7);
  const mk = (a, m, d) => { const s = `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isNaN(Date.parse(s)) ? null : s; };
  let m = t.match(/\b(\d{1,2}) de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
  if (m) { const mm = MESES.indexOf(m[2]) + 1; let d = mk(y, mm, +m[1]); if (d && d < somaDias(base, -60)) d = mk(y + 1, mm, +m[1]); return d; }
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) { let d = mk(y, +m[2], +m[1]); if (d && d < somaDias(base, -60)) d = mk(y + 1, +m[2], +m[1]); return d; }
  const perto = dd => { let d = mk(y, mo, dd); if (d && d < somaDias(base, -3)) d = mo === 12 ? mk(y + 1, 1, dd) : mk(y, mo + 1, dd); return d; };
  m = t.match(/\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?,? \((\d{1,2})(\/\d{1,2})?\)/);
  if (m) return perto(+m[3]);
  m = t.match(/\bdia (\d{1,2})\b/);
  if (m && +m[1] >= 1 && +m[1] <= 31) return perto(+m[1]);
  m = t.match(/\b(nesta|nessa|esta|essa|neste|nesse|este|esse|na|no|proxima|proximo|na proxima|no proximo)\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/);
  if (m) { let off = (DIAS.indexOf(m[2]) - semana(base) + 7) % 7; if (off === 0 && /proxim/.test(m[1])) off = 7; return somaDias(base, off); }
  if (/\bamanha\b/.test(t)) return somaDias(base, 1);
  if (/\bhoje\b/.test(t)) return base;
  return null;
}
const TIPOS = [
  ['Balanço', /\bbalanco\b|\bresultados?\b|\btrimestr|\b\dt\d{2}\b|\bearnings\b/],
  ['Estreia na bolsa', /\bipo\b|estreia na bolsa|oferta publica inicial|precifica/],
  ['Lançamento', /\blanca(mento|ra|rao)?\b|\bchega(ra)? (as lojas|ao mercado|aos consoles|nest[ae]|na |no |em |dia |amanha|hoje)|\bestreia\b/],
  ['Decisão de juros', /\b(copom|fomc|fed|banco central)\b.*\b(decide|decisao|reuniao|define|juros|selic)\b|\b(decisao|reuniao) do (copom|fed|fomc)\b/],
  ['Indicador', /\b(ipca|payroll|pib|cpi|inflacao)\b/]
];
const FUTURO = /\bdivulga(ra|rao|m)?\b|vai divulgar|\bapresenta(ra|rao)?\b|\bsera\b|\bserao\b|\bmarcad|\bprevist|\bagenda|\bprogramad|\bchega(ra)?\b|\blanca(ra)?\b|\bestreia(ra)?\b|\bdecide\b|\bdecidira\b|\bse reune|o que esperar|\bexpectativa|\bantes d[oa]\b|\bconfirma(da|do)?\b|\bpromete\b/;
const PASSADO = /\bapos\b(?! (o|a) (fechamento|abertura|pregao))|depois d|\bdivulgou\b|\bapresentou\b|\blancou\b|\bestreou\b|\bdecidiu\b|\bmanteve\b|\bsubiu\b|\bcaiu\b|\breage|\bsurpreend|\bsupera\b|\bdecepciona|\bfoi\b|\bpublicad[oa]\b/;
const MACRO = { 'Decisão de juros': t => /copom|selic/.test(t) ? 'Copom' : 'Fed', 'Indicador': t => (t.match(/\b(ipca|payroll|pib|cpi)\b/) || ['', 'Indicador'])[1].toUpperCase() };

export function evento(titulo, pubMs, empresas, hojeBR) {
  const t = sem(titulo);
  if (!FUTURO.test(t) || PASSADO.test(t)) return null;
  const tp = TIPOS.find(([, re]) => re.test(t)); if (!tp) return null;
  let empresa = achaEmpresa(t, empresas);
  if (!empresa && MACRO[tp[0]]) empresa = MACRO[tp[0]](t);
  if (!empresa) return null;
  const data = extrairData(titulo, pubMs);
  if (!data || data < hojeBR || data < diaBR(pubMs) || data > somaDias(hojeBR, 10)) return null;
  return { data, tipo: tp[0], empresa };
}
const tituloEv = e => e.tipo === 'Decisão de juros' ? `${e.empresa} decide os juros` : e.tipo === 'Indicador' ? `Sai o ${e.empresa}` : e.tipo === 'Lançamento' ? `Lançamento: ${e.empresa}` : `${e.tipo}: ${e.empresa}`;

// Calendario de balancos dos EUA (Nasdaq). Se falhar, o robo segue so com as noticias.
async function balancosEUA(mapa, hojeBR, dias = 7) {
  const out = []; if (!mapa || !Object.keys(mapa).length) return out;
  for (let k = 0; k < dias; k++) {
    const dia = somaDias(hojeBR, k); const w = semana(dia); if (w === 0 || w === 6) continue;
    const r = await fetch(`${CAL}/api/calendar/earnings?date=${dia}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('calendario http ' + r.status);
    const j = await r.json();
    const rows = (j && j.data && (j.data.rows || (j.data.calendar && j.data.calendar.rows))) || [];
    for (const x of rows) {
      const nome = mapa[String(x.symbol || '').toUpperCase()]; if (!nome) continue;
      const hora = /after/i.test(x.time || '') ? 'após o fechamento dos EUA' : /pre/i.test(x.time || '') ? 'antes da abertura dos EUA' : '';
      out.push({ data: dia, tipo: 'Balanço', empresa: nome, hora, origem: 'calendário Nasdaq', link: 'https://www.nasdaq.com/market-activity/earnings' });
    }
  }
  return out;
}

// ---------- RSS ----------
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

const STOP = new Set(['para', 'com', 'que', 'dos', 'das', 'uma', 'por', 'nas', 'nos', 'sobre', 'apos', 'mais']);
const toks = s => new Set(sem(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
export function parecidas(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return false;
  let i = 0; A.forEach(w => { if (B.has(w)) i++; });
  return i / (A.size + B.size - i) >= 0.5;
}
const idDe = s => { let h = 0; const t = sem(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h.toString(36); };

export function consultas(cfg) {
  const q = [];
  const chunk = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
  chunk([...(cfg.empresasBR || []), ...(cfg.empresasUS || [])], 6).forEach(g => q.push({ q: g.map(x => '"' + x + '"').join(' OR ') }));
  (cfg.termos || []).forEach(t => q.push(typeof t === 'string' ? { q: t } : t));
  (cfg.termosAgenda || []).forEach(t => q.push({ q: t, quando: '4d', agenda: true }));
  return q;
}
async function buscar(c) {
  const url = `${NEWS}/rss/search?q=${encodeURIComponent(c.q + ' when:' + (c.quando || '1d'))}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 orbit-noticias' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return parseRss(await r.text());
}
async function ntfy(topic, titulo, msg, link, prio = 3, tag = 'newspaper') {
  const body = { topic, title: titulo, message: msg, priority: prio, tags: [tag] };
  if (link) body.click = link;
  const r = await fetch(NTFY, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('ntfy ' + r.status);
}
function lerJson(f, pad) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return pad; } }

export async function main(dir = '.') {
  const cfg = { limiarAviso: 7, maxPorRodada: 1, maxPorDia: 6, horaInicio: 7, horaFim: 23, horasMesmoAssunto: 48, ...lerJson(`${dir}/noticias-config.json`, {}) };
  const listadas = [...(cfg.empresasBR || []), ...(cfg.empresasUS || [])];
  const empresas = [...listadas, ...(cfg.destaques || [])];
  const topic = (process.env.NTFY_TOPIC || '').trim();
  const conf = (cfg.fontesConfiaveis || []).map(sem), bloq = (cfg.fontesBloqueadas || []).map(sem);
  const arq = `${dir}/news.json`;
  const base = lerJson(arq, { atualizado: '', itens: [] });
  const agora = AGORA(), hojeBR = diaBR(agora), hBR = new Date(agora - 3 * 36e5).getUTCHours();
  let itens = (base.itens || []).filter(x => agora - Date.parse(x.data) < 72 * 36e5 && !ingles(x.titulo))
    .filter(x => !bloq.some(b => sem(x.fonte).includes(b)))
    .map(x => { const p = pontuar(x.titulo, empresas, listadas); if (conf.some(b => sem(x.fonte).includes(b))) p.score += 1; return { ...x, cat: p.cat, empresa: p.empresa, score: p.score, marco: p.marco || false }; })
    .filter(x => x.score >= 4); // regras novas valem tambem para o que ja estava na lista
  const evAv = { ...(base.eventosAvisados || {}) };
  Object.keys(evAv).forEach(k => { if (agora - evAv[k] > 20 * 864e5) delete evAv[k]; });
  // agenda guardada (descarta o que ja passou)
  let agenda = (base.agenda || []).filter(e => e.data >= hojeBR);

  // 1) noticias + eventos lidos das manchetes
  let falhas = 0; const qs = consultas(cfg); let novas = 0;
  const addEv = e => { const k = e.data + '|' + sem(e.empresa) + '|' + e.tipo; const i = agenda.findIndex(x => x.data + '|' + sem(x.empresa) + '|' + x.tipo === k); if (i < 0) agenda.push(e); else if (e.origem === 'calendário Nasdaq') agenda[i] = e; };
  for (const c of qs) {
    let lista = [];
    try { lista = await buscar(c); } catch (e) { falhas++; console.log('Falha na busca:', c.q.slice(0, 40), e.message); continue; }
    for (const n of lista) {
      const ms = Date.parse(n.data);
      if (ms > agora + 36e5 || ingles(n.titulo)) continue;
      if (agora - ms <= 5 * 864e5) { const ev = evento(n.titulo, ms, empresas, hojeBR); if (ev) addEv({ ...ev, origem: n.fonte, link: n.link, manchete: n.titulo }); }
      if (c.agenda || agora - ms > 30 * 36e5) continue;
      const fs = sem(n.fonte);
      if (bloq.some(b => fs.includes(b))) continue; // redes sociais e afins: fora
      const p = pontuar(n.titulo, empresas, listadas);
      if (conf.some(b => fs.includes(b))) p.score += 1; // fonte jornalistica conhecida vale um ponto a mais
      if (p.score < 4) continue;
      const id = idDe(n.titulo);
      if (itens.some(x => x.id === id || parecidas(x.titulo, n.titulo))) continue;
      itens.push({ id, titulo: n.titulo, fonte: n.fonte, link: n.link, data: n.data, cat: p.cat, empresa: p.empresa, score: p.score, marco: p.marco || false, avisado: false });
      novas++;
    }
  }
  // 2) calendario de balancos dos EUA (1x a cada 6h)
  let calOk = base.agendaCal || '';
  if (!calOk || agora - Date.parse(calOk) > 6 * 36e5) {
    try { (await balancosEUA(cfg.agendaEUA, hojeBR)).forEach(addEv); calOk = new Date(agora).toISOString(); }
    catch (e) { console.log('Calendário de balanços indisponível:', e.message); }
  }
  // 3) eventos cadastrados a mao (opcional)
  (cfg.eventos || []).forEach(e => { if (e.data >= hojeBR) addEv({ data: e.data, tipo: e.tipo || 'Evento', empresa: e.titulo, hora: e.hora || '', origem: 'manual', link: e.link || '' }); });
  agenda.sort((a, b) => a.data.localeCompare(b.data));
  agenda = agenda.slice(0, 40);

  itens.sort((a, b) => Date.parse(b.data) - Date.parse(a.data));
  itens = itens.slice(0, 150);

  // 4) avisos
  const janela = FORCE || (hBR >= cfg.horaInicio && hBR < cfg.horaFim);
  let enviados = 0, errNtfy = 0;
  if (!topic) console.log('NTFY_TOPIC vazio: sem avisos.');
  if (topic && janela) {
    if (FORCE) { try { await ntfy(topic, 'Notícias do Orbit funcionando', `Teste ok. ${itens.length} notícia(s) e ${agenda.length} evento(s) na agenda.` + (falhas ? ` ${falhas} busca(s) falharam.` : ''), '', 3); enviados++; } catch (e) { errNtfy++; console.log('Falha no teste:', e.message); } }
    // agenda do dia: uma mensagem por dia, de manha
    const dk = 'dig|' + hojeBR;
    if (!evAv[dk]) {
      const amanha = somaDias(hojeBR, 1);
      const fmt = e => tituloEv(e) + (e.hora ? ` (${e.hora})` : '');
      const hoje = agenda.filter(e => e.data === hojeBR).map(fmt), am = agenda.filter(e => e.data === amanha).map(fmt);
      if (hoje.length || am.length) {
        const txt = (hoje.length ? 'Hoje: ' + hoje.join('; ') + '.' : '') + (am.length ? (hoje.length ? ' ' : '') + 'Amanhã (' + DIAS_TXT[semana(amanha)] + '): ' + am.join('; ') + '.' : '') + ' Eventos assim costumam mexer com o preço. Evite comprar no impulso.';
        try { await ntfy(topic, 'Agenda do mercado', txt, '', 4, 'calendar'); evAv[dk] = agora; enviados++; } catch (e) { errNtfy++; console.log('Falha no aviso de agenda:', e.message); }
      } else evAv[dk] = agora;
    }
    // noticias: so a mais importante da rodada, sem repetir assunto em 48h (salvo um marco novo)
    const hoje = itens.filter(x => x.avisadoEm && agora - x.avisadoEm < 864e5).length;
    const tema = x => sem(x.empresa || x.cat);
    const ultimoTema = {}; itens.forEach(x => { if (x.avisadoEm) ultimoTema[tema(x)] = Math.max(ultimoTema[tema(x)] || 0, x.avisadoEm); });
    const vagas = Math.max(0, Math.min(cfg.maxPorRodada, cfg.maxPorDia - hoje));
    const cand = itens.filter(x => !x.avisado && agora - Date.parse(x.data) < 12 * 36e5 && x.score >= cfg.limiarAviso)
      .filter(x => !ultimoTema[tema(x)] || agora - ultimoTema[tema(x)] > cfg.horasMesmoAssunto * 36e5 || (x.marco && agora - ultimoTema[tema(x)] > 6 * 36e5))
      .sort((a, b) => b.score - a.score || Date.parse(b.data) - Date.parse(a.data));
    for (const x of cand.slice(0, vagas)) {
      try { await ntfy(topic, `${x.cat}${x.empresa ? ' · ' + x.empresa : ''}`, `${x.titulo} (${x.fonte})`, x.link, x.score >= 10 ? 4 : 3); x.avisado = true; x.avisadoEm = agora; enviados++; }
      catch (e) { errNtfy++; console.log('Falha ao avisar:', e.message); }
    }
  }
  const novo = { atualizado: new Date(agora).toISOString(), agendaCal: calOk, eventosAvisados: evAv, agenda, itens };
  const mudou = JSON.stringify({ ...novo, atualizado: '' }) !== JSON.stringify({ ...base, atualizado: '' });
  if (mudou) fs.writeFileSync(arq, JSON.stringify(novo, null, 1) + '\n');
  console.log(`Buscas: ${qs.length - falhas}/${qs.length}. Novas: ${novas}. Agenda: ${agenda.length}. Avisos: ${enviados}.`);
  if (qs.length && falhas === qs.length) return 1;
  return errNtfy ? 1 : 0;
}

if (!process.env.ORBIT_NO_RUN && process.argv[1] === fileURLToPath(import.meta.url)) main('.').then(c => process.exit(c));
