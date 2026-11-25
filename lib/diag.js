// Diagnostic S et information Vinted : fonctions pures sur la sortie de measure() et le fichier de cibles (targets.py).
// La définition de S vient de targets.s_def. Rien ici ne calcule, ne renvoie ni ne modifie un réglage de retouche.
const QS = [5, 25, 50, 75, 95];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const ok = (x) => typeof x === 'number' && Number.isFinite(x);

// valeur transformée d'une composante ("a+b" = somme), null si une partie manque ou si le seuil bg_edges est null
function value(m, key, tf, thr) {
  const parts = key === 'bg_edges' ? (thr ? [`bg_edges_${thr}`] : []) : key.split('+');
  if (!parts.length || !parts.every((p) => ok(m[p]))) return null;
  const v = parts.reduce((s, p) => s + m[p], 0);
  return tf === 'log' ? (v > 0 ? Math.log(v) : null) : v;
}

// percentile 0..100 de x par interpolation sur p (quantiles 5, 25, 50, 75, 95) ; borné à 5..95 (rien d'écrit au-delà)
function pctOf(x, p) {
  if (!Array.isArray(p) || p.length !== 5 || !ok(x)) return null;
  if (x <= p[0]) return QS[0];
  if (x >= p[4]) return QS[4];
  for (let i = 0; i < 4; i++) if (x <= p[i + 1]) return p[i + 1] === p[i] ? QS[i + 1] : QS[i] + ((x - p[i]) / (p[i + 1] - p[i])) * (QS[i + 1] - QS[i]);
  return null;
}

// scoreS(m, n2, targets) -> {S, attrs:{attr:z|null}, pct:{attr|S:0..100|null}} ; tout à null sans groupe (ni N2 ni _pooled) : « provisoire ».
export function scoreS(m, n2, targets) {
  const def = targets.s_def, g = targets.n2?.[String(n2)] ?? targets.n2?._pooled ?? null;
  const attrs = {}, pct = {};
  for (const a of Object.keys(def.attrs)) { attrs[a] = null; pct[a] = null; }
  let S = null;
  pct.S = null;
  if (!g) return { S, attrs, pct };
  for (const [a, comps] of Object.entries(def.attrs)) {
    const zs = [];
    for (const c of comps) {
      const v = value(m, c.key, c.tf, def.bg_edges_threshold), st = g.comp?.[c.key];
      if (v !== null && st && st.sd > 0) zs.push((c.sign * (v - st.mean)) / st.sd);
    }
    if (zs.length) { attrs[a] = mean(zs); pct[a] = pctOf(attrs[a], g.attrs?.[a]?.p); }
  }
  const present = Object.values(attrs).filter((z) => z !== null);
  if (present.length >= def.min_attrs) { S = mean(present); pct.S = pctOf(S, g.S?.p); }
  return { S, attrs, pct };
}

// niveau d'un attribut sans effet mesuré : lu dans targets.levels, « provisoire » si absent
const half = (x) => Math.sign(x) * Math.round(Math.abs(x) * 2) / 2;   // au 0,5 le plus proche, symétrique autour de 0
const fr = (x) => String(x === 0 ? 0 : x).replace('.', ',');

export function evidence(attrKey, targets) {
  const ef = targets.effects?.[attrKey];
  if (!ef) { const level = targets.levels?.[attrKey] || 'provisoire'; return { level, verdict: null, text: `${level}.` }; }
  const verdict = ef.verdict || 'non concluant', tail = ` Période : ${ef.period}. Saison : ${ef.season}.`;
  if (verdict !== 'association pertinente') return { level: ef.level, verdict, text: `${ef.level} : ${verdict}.${tail}` };
  const more = ef.dp >= 0;
  return { level: ef.level, verdict, text:
    `Les annonces aux photos de ce type se vendent ${fr(Math.abs(half(ef.dp)))} points de ${more ? 'plus' : 'moins'} [${fr(half(ef.lo))} ; ${fr(half(ef.hi))}]. Ce n'est pas l'effet mesuré d'une retouche.${tail}` };
}

// conseils fixes du fichier (scope « all » ou celui de l'annonce) ; texte et niveau seulement
export function adviceFor(item, targets) {
  return (targets.advice || []).filter((a) => a.scope === 'all' || a.scope === item?.scope).map((a) => ({ text: a.text, level: a.level }));
}
