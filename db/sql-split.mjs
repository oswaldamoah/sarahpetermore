// Splits a SQL script into single statements, respecting quotes, E'' strings,
// dollar-quoted bodies ($$ … $$ / $tag$ … $tag$) and comments.
export function splitSql(sql) {
  const out = []; let cur = ''; let i = 0; const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { const j = sql.indexOf('\n', i); const end = j < 0 ? n : j + 1; cur += sql.slice(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const j = sql.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; cur += sql.slice(i, end); i = end; continue; }
    if (c === "'") {
      const isE = /[eE]$/.test(cur) && !/[a-zA-Z0-9_][eE]$/.test(cur);
      let j = i + 1;
      while (j < n) {
        if (isE && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '"') { const j = sql.indexOf('"', i + 1); const end = j < 0 ? n : j + 1; cur += sql.slice(i, end); i = end; continue; }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]$/.test(cur)) {
        const tag = m[0]; const j = sql.indexOf(tag, i + tag.length); const end = j < 0 ? n : j + tag.length;
        cur += sql.slice(i, end); i = end; continue;
      }
    }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.replace(/--.*$/gm, '').trim()) out.push(cur.trim());
  return out.filter((s) => s.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}
