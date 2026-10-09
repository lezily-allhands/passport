'use strict';
/*
 * 全員集合会パスポート — 画面（GitHub Pages）
 * このファイルには、人名・日付・場所・文面・合言葉などの固有の情報を書かない。
 * すべてログイン後に API から受け取る。
 */
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/<デプロイID>/exec', // Apps Script の「ウェブアプリ」URL（/dev ではなく /exec）
  CLIENT_ID: '<OAuthクライアントID>.apps.googleusercontent.com',
};

/* ================================================================== */
/* 状態・保存                                                          */
/* ================================================================== */
const S = { sid: '', data: null, cur: '', screen: 'boot', popup: null, busy: false, deniedEmail: '', bootError: false };

const store = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch (_) { return ''; } },
  set(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (_) { /* 保存できなくても動く */ } },
};

/* ================================================================== */
/* 文言                                                                */
/* ================================================================== */
const MSG = {
  bad: 'うまくいきませんでした。もう一度ためしてね',
  unknown: 'うまくいきませんでした。もう一度ためしてね',
  server: 'うまくいきませんでした。もう一度ためしてね',
  denied: 'この操作はできません',
  notfound: 'カードが見つかりません',
  wrongcode: '合言葉がちがいます。もう一度たしかめてね',
  locked: 'まちがいが続いたので、10分ほど待ってからためしてね',
  notopen: 'いまは合言葉を受け付けていません',
  busy: '少し待ってから、もう一度ためしてね',
  retry: 'もう一度ログインしてください',
  net: '通信できませんでした。電波のよいところで、もう一度ためしてね',
};
function msgOf(code) {
  if (code === 'toomany') return 'カードは' + maxCards() + '枚までです';
  return MSG[code] || MSG.server;
}

/* ================================================================== */
/* 小さな道具                                                           */
/* ================================================================== */
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
function safeColor(c, d) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : d; }
function nl2br(s) { return esc(s).replace(/\r?\n/g, '<br>'); }
function themeHtml(t) { return String(t || '').trim().split(/[\s　]+/).filter(Boolean).map(esc).join('<br>'); }
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return { y: +m[1], mo: +m[2], d: +m[3], w: WEEK[d.getUTCDay()] };
}
function fmtDate(s, withWeek) {
  const p = parseDate(s);
  if (!p) return esc(s || '');
  return p.y + '年' + p.mo + '月' + p.d + '日' + (withWeek ? '（' + p.w + '）' : '');
}
function mapUrl(q) { return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : ''; }
function extLink(url, label, cls) {
  const u = safeUrl(url);
  return u ? '<a class="' + (cls || 'link') + '" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : '';
}
function firstChar(s) { return Array.from(String(s || '').trim())[0] || '?'; }
function maxCards() { return (S.data && S.data.max) || 10; }

/* ================================================================== */
/* API                                                                 */
/* ================================================================== */
async function api(fn, args = []) {
  const body = JSON.stringify({ fn, args, sid: S.sid || '' });
  const r = await fetch(CONFIG.API_URL, { method: 'POST', body, credentials: 'omit', redirect: 'follow' });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (j && j.error === 'expired') { toLogin(); throw new Error('expired'); }
  return j;
}

/** 送信中は二重送信を防ぐ（ボタンを無効化） */
async function withBusy(fn) {
  if (S.busy) return;
  S.busy = true;
  setButtonsDisabled(true);
  try { await fn(); }
  catch (e) { if (e && e.message !== 'expired') toast(MSG.net); }
  finally { S.busy = false; setButtonsDisabled(false); }
}
function setButtonsDisabled(on) {
  document.querySelectorAll('#app button, #app input[type=submit]').forEach(b => {
    if (on) { if (!b.disabled) { b.disabled = true; b.dataset.busy = '1'; } }
    else if (b.dataset.busy) { b.disabled = false; delete b.dataset.busy; }
  });
}

/* ================================================================== */
/* データ                                                              */
/* ================================================================== */
const AQ = new Map(); // こたえの送信待ち（カードID:番号 → 状態）

function setData(d) {
  if (!d || typeof d !== 'object') return;
  // 送信が終わっていないこたえは、手元の値を優先する（古い値で上書きしない）
  (d.cards || []).forEach(c => {
    [1, 2, 3].forEach(i => {
      const q = AQ.get(c.id + ':' + i);
      if (q && q.dirty) c.answers[i - 1] = q.value;
    });
  });
  S.data = d;
  if (!cards().some(c => c.id === S.cur)) setCur(selfCard() ? selfCard().id : '');
}
function cards() { return (S.data && Array.isArray(S.data.cards)) ? S.data.cards : []; }
function selfCard() { return cards().find(c => c.kind === 'self') || cards()[0] || null; }
function curCard() { return cards().find(c => c.id === S.cur) || selfCard(); }
function findCard(id) { return cards().find(c => c.id === id) || null; }
function setCur(id) { S.cur = id || ''; store.set('zp_cur', S.cur); }
function clearCount(c) { return (c.clears || []).filter(Boolean).length; }
function isKid(c) { return !!c && c.kind === 'kid'; }
function staffOf(role) { return ((S.data && S.data.staff) || []).find(s => s.role === role) || null; }
function staffName(role) { const s = staffOf(role); return s && s.name ? s.name : (role === 'cert' ? '社長' : '実行委員'); }
function missionsFor(c) {
  const m = (S.data && S.data.missions) || {};
  return (isKid(c) ? m.kid : m.adult) || [];
}
function cardLabel(c) { return c.name || ''; }

/** 参加回数（今回より前の参加数＋1）と皆勤賞 */
function recordSummary() {
  const d = S.data;
  const cur = d.event.no;
  const hist = d.history || [];
  const before = hist.filter(h => h.no < cur);
  const n = before.filter(h => h.attended).length + 1;
  const join = d.me.join;
  let perfect = false;
  if (join < cur) {
    perfect = true;
    for (let no = join; no < cur; no++) {
      const h = hist.find(x => x.no === no);
      if (!h || !h.attended) { perfect = false; break; }
    }
  }
  return { n, first: before.filter(h => h.attended).length === 0, perfect };
}

/* ================================================================== */
/* イラスト（固有の人を表さない）                                         */
/* ================================================================== */
let gid = 0;
function face(st, size) {
  const s = st || {};
  const f = s.face || {};
  const cert = s.role === 'cert';
  const ring = safeColor(s.color, cert ? '#C99A2E' : '#E8892F');
  const hair = safeColor(f.hair, '#3B2A20');
  const id = 'f' + (++gid);
  const longHair = f.long ? '<path d="M22 56 Q20 22 50 22 Q80 22 78 56 L80 92 L20 92 Z" fill="' + hair + '"/>' : '';
  const glasses = f.glasses
    ? '<g fill="none" stroke="#2E2A26" stroke-width="2.2"><circle cx="41" cy="55" r="7"/><circle cx="59" cy="55" r="7"/><path d="M48 55 h4"/></g>'
    : '';
  return '<svg class="face" width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true">' +
    '<defs>' +
      (cert ? '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F7E7B8"/><stop offset=".5" stop-color="#C99A2E"/><stop offset="1" stop-color="#E9C766"/></linearGradient>' : '') +
      '<clipPath id="' + id + 'c"><circle cx="50" cy="50" r="41"/></clipPath>' +
    '</defs>' +
    '<circle cx="50" cy="50" r="48" fill="' + (cert ? 'url(#' + id + 'g)' : ring) + '"/>' +
    '<circle cx="50" cy="50" r="41" fill="#FFF7EC"/>' +
    '<g clip-path="url(#' + id + 'c)">' +
      longHair +
      '<path d="M30 100 Q30 78 50 78 Q70 78 70 100 Z" fill="' + ring + '" opacity=".85"/>' +
      '<ellipse cx="50" cy="55" rx="21" ry="23" fill="#F6D3B6"/>' +
      '<path d="M28 52 Q26 28 50 27 Q74 28 72 52 Q68 40 56 38 Q46 44 34 42 Q30 46 28 52 Z" fill="' + hair + '"/>' +
      '<circle cx="41" cy="56" r="2.6" fill="#2E2A26"/><circle cx="59" cy="56" r="2.6" fill="#2E2A26"/>' +
      '<circle cx="36" cy="64" r="4" fill="#F4A3A0" opacity=".55"/><circle cx="64" cy="64" r="4" fill="#F4A3A0" opacity=".55"/>' +
      '<path d="M44 67 Q50 72 56 67" fill="none" stroke="#2E2A26" stroke-width="2.2" stroke-linecap="round"/>' +
      glasses +
    '</g></svg>';
}
function seal(role, size, pop) {
  const st = staffOf(role) || { role };
  const cert = role === 'cert';
  const c = safeColor(st.color, cert ? '#C99A2E' : '#E8892F');
  return '<span class="seal' + (pop ? ' pop' : '') + (cert ? ' gold' : '') + '">' + face(st, size) +
    '<span class="seal-label"' + (cert ? '' : ' style="background:' + c + '"') + '>' + (cert ? '社長認定' : 'CLEAR!') + '</span></span>';
}
function flower(size) {
  let p = '';
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 - 90) * Math.PI / 180;
    p += '<circle cx="' + (50 + Math.cos(a) * 22).toFixed(1) + '" cy="' + (50 + Math.sin(a) * 22).toFixed(1) + '" r="19"/>';
  }
  return '<svg class="flower" width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true"><g class="petal">' + p +
    '</g><circle cx="50" cy="50" r="13" class="pistil"/></svg>';
}
function crowd() {
  const person = (x, cls, hairCls, armUp) =>
    '<g transform="translate(' + x + ' 0)">' +
      '<path d="M-22 120 Q-22 78 0 78 Q22 78 22 120 Z" class="' + cls + '"/>' +
      (armUp === 'both' || armUp === 'l' ? '<path d="M-14 86 L-30 48" class="arm ' + cls + 's"/>' : '<path d="M-16 88 L-26 112" class="arm ' + cls + 's"/>') +
      (armUp === 'both' || armUp === 'r' ? '<path d="M14 86 L30 48" class="arm ' + cls + 's"/>' : '<path d="M16 88 L26 112" class="arm ' + cls + 's"/>') +
      '<circle cx="0" cy="58" r="17" class="skin"/>' +
      '<path d="M-17 56 Q-17 38 0 38 Q17 38 17 56 Q10 48 0 48 Q-10 48 -17 56 Z" class="' + hairCls + '"/>' +
      '<circle cx="-6" cy="60" r="2" class="eye"/><circle cx="6" cy="60" r="2" class="eye"/>' +
      '<path d="M-5 66 Q0 70 5 66" class="smile"/>' +
    '</g>';
  return '<svg class="crowd" viewBox="0 0 300 124" role="img" aria-label="手を挙げてよろこぶ4人のイラスト">' +
    person(48, 'c1', 'h1', 'both') + person(118, 'c2', 'h2', 'r') + person(184, 'c3', 'h1', 'both') + person(252, 'c4', 'h2', 'l') +
    '</svg>';
}
function dotted(text, big) {
  return '<span class="slot' + (big ? ' big' : '') + '"><span>' + text + '</span></span>';
}

/* ================================================================== */
/* 画面                                                                */
/* ================================================================== */
function go(screen) {
  if (screen !== 'login') stopLoginTimer();
  S.screen = screen;
  S.popup = null;
  render();
  window.scrollTo(0, 0);
  if (screen === 'login') prepareLogin('');
}
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const fn = SCREENS[S.screen] || SCREENS.boot;
  app.innerHTML = '<main class="screen screen-' + esc(S.screen) + '">' + fn() + '</main>' + (S.popup ? renderPopup() : '');
  app.dataset.kid = (S.screen === 'card' || S.screen === 'cert') && isKid(curCard()) ? '1' : '';
  if (S.popup) {
    const f = app.querySelector('.modal [data-autofocus]');
    if (f) setTimeout(() => f.focus(), 30);
  }
}
function openPopup(p) { S.popup = p; render(); }
function closePopup() { S.popup = null; render(); }

const SCREENS = {
  boot() {
    if (S.bootError) {
      return '<div class="center"><p>' + esc(MSG.net) + '</p><button class="btn" data-act="retryBoot">もう一度よみこむ</button></div>';
    }
    return '<div class="center"><div class="spinner" aria-hidden="true"></div><p class="sub">よみこみ中…</p></div>';
  },

  login() {
    return '<div class="login">' +
      '<h1 class="title">全員集合会パスポート</h1>' +
      crowd() +
      '<p class="lead">Lezilyのメンバーは、Googleアカウントでログインしてください。ご家族の分のミッションカードは、ログイン後に追加できます</p>' +
      '<div id="gsi" class="gsi"></div>' +
      '<p id="loginMsg" class="msg" role="status"></p>' +
      '<button class="btn ghost hidden" id="loginRetry" data-act="loginRetry">もう一度ためす</button>' +
    '</div>';
  },

  denied() {
    return '<div class="login">' +
      '<h1 class="title">全員集合会パスポート</h1>' +
      '<div class="box"><h2 class="h2">このGoogleアカウントは登録されていません</h2>' +
      (S.deniedEmail ? '<p class="email">' + esc(S.deniedEmail) + '</p>' : '') +
      '<p>登録されているアカウントでログインし直してください。わからない場合は運営にお問い合わせください</p></div>' +
      '<button class="btn" data-act="logout">別のアカウントでログインする</button>' +
    '</div>';
  },

  home() {
    const d = S.data;
    const me = d.me, ev = d.event;
    const hello = me.nick || (me.name + ' さん');
    const self = selfCard();
    const sum = recordSummary();
    const seals = [];
    if (self) {
      (self.clears || []).forEach((c, i) => { if (c) seals.push(seal('M' + (i + 1), 56)); });
      if (self.cert) seals.push(seal('cert', 56));
    }
    const fam = cards().filter(c => c.kind !== 'self');
    return '' +
      '<header class="hello">' +
        '<div class="avatar" aria-hidden="true">' + esc(firstChar(me.nick || me.name)) + '</div>' +
        '<div><div class="hello-t">' + esc(hello) + '、ようこそ！</div><div class="sub">' + esc(me.name) + '</div></div>' +
      '</header>' +

      '<section class="box event">' +
        '<div class="kicker">第' + esc(ev.no) + '回 全員集合会</div>' +
        (ev.theme ? '<h1 class="theme">' + themeHtml(ev.theme) + '</h1>' : '') +
        '<dl class="info">' +
          (ev.date ? '<div><dt>日にち</dt><dd>' + fmtDate(ev.date, true) + '</dd></div>' : '') +
          (ev.gather ? '<div><dt>集合</dt><dd>' + esc(ev.gather) + '</dd></div>' : '') +
        '</dl>' +
        (ev.place ? '<button class="link-btn" data-act="place">場所を見る →</button>' : '') +
        extLink(ev.detailUrl, '当日の詳しいご案内を見る', 'link block') +
      '</section>' +

      '<section class="box">' +
        '<h2 class="h2">参加記録</h2>' + summaryHtml(sum) +
        '<button class="link-btn" data-act="record">スタンプを見る →</button>' +
      '</section>' +

      '<section class="box">' +
        '<h2 class="h2">獲得したシール</h2>' +
        (seals.length ? '<div class="seals">' + seals.join('') + '</div>' : '<p class="sub">まだありません。ミッションをクリアするともらえます</p>') +
        (fam.length ? '<p class="fam">ご家族のカード：' + fam.map(c => esc(c.name) + ' ' + clearCount(c) + '/3').join('、') + '</p>' : '') +
      '</section>' +

      '<button class="btn big" data-act="openCard">第' + esc(ev.no) + '回 ミッションカードを開く</button>';
  },

  place() {
    const ev = S.data.event;
    const q = ev.map || ev.place;
    return '<div class="topbar"><button class="back" data-act="home">← もどる</button></div>' +
      '<section class="box">' +
        '<div class="kicker">場所</div>' +
        '<h1 class="h1">' + esc(ev.place) + '</h1>' +
        (ev.access ? '<p class="pre">' + nl2br(ev.access) + '</p>' : '') +
        (q ? extLink(mapUrl(q), '地図をひらく', 'btn') : '') +
      '</section>';
  },

  card() {
    const d = S.data;
    const c = curCard();
    if (!c) return '<p>' + esc(MSG.notfound) + '</p>';
    const kid = isKid(c);
    const n = clearCount(c);
    const ms = missionsFor(c);
    const list = cards();
    const chips = list.map(x =>
      '<button class="chip' + (x.id === c.id ? ' on' : '') + '" data-act="pick" data-id="' + esc(x.id) + '" aria-pressed="' + (x.id === c.id) + '">' +
        '<span class="chip-n">' + esc(cardLabel(x)) + '</span><span class="chip-c">' + clearCount(x) + '/3</span></button>').join('') +
      (list.length < maxCards()
        ? '<button class="chip add" data-act="addCard">＋ 家族のカード</button>'
        : '<span class="chip-max">カードは' + maxCards() + '枚までです</span>');

    const missionHtml = [0, 1, 2].map(i => {
      const m = ms.find(x => x.no === i + 1) || { who: '', label: '', q: '', color: '#E8892F' };
      const role = 'M' + (i + 1);
      const st = staffOf(role);
      const sc = safeColor(st && st.color, '#E8892F');
      const mc = safeColor(m.color, '#E8892F');
      const done = !!(c.clears || [])[i];
      return '<div class="mission' + (done ? ' done' : '') + '">' +
        '<div class="m-main">' +
          '<div class="m-no" style="color:' + sc + '">MISSION ' + (i + 1) + '</div>' +
          '<p class="m-text">' +
            '<span class="tag" style="background:' + sc + '">' + (kid ? 'だれに' : '誰に') + '</span> ' + esc(m.who) + '<br>' +
            (m.label ? '<span class="tag" style="background:' + mc + '">' + esc(m.label) + '</span> ' : '') + esc(m.q) +
          '</p>' +
          '<textarea class="ans" rows="2" maxlength="200" data-card="' + esc(c.id) + '" data-idx="' + (i + 1) + '" placeholder="' +
            (kid ? 'こたえをかこう' : '聞いたことをメモ') + '" aria-label="MISSION ' + (i + 1) + ' のこたえ">' + esc((c.answers || [])[i] || '') + '</textarea>' +
        '</div>' +
        '<div class="m-slot">' + (done ? seal(role, 62, S.justCleared && S.justCleared[c.id + role]) : dotted(esc(staffName(role)) + 'の<br>CLEAR')) + '</div>' +
      '</div>';
    }).join('');

    return '<div class="topbar"><button class="back" data-act="home">← ホーム</button></div>' +
      (d.event.theme ? '<div class="theme small">' + themeHtml(d.event.theme) + '</div>' : '') +
      '<h1 class="h1 center-t">ミッションカード</h1>' +
      '<div class="chips" role="group" aria-label="カードの切り替え">' + chips + '</div>' +
      (c.kind !== 'self'
        ? '<div class="owner"><span>' + esc(c.name) + ' さんのカード</span><button class="mini" data-act="askDelete">このカードを削除</button></div>'
        : '') +
      '<p class="lead">' + (kid ? '3つ クリアしたら ひょうしょうじょうが ひらくよ' : '3つクリアしたら表彰状がひらきます') + '</p>' +
      missionHtml +
      (n < 3
        ? '<p class="hint">ミッションができたら、担当の実行委員に合言葉を聞いて入力してね（' + n + '/3 クリア）</p>' +
          '<button class="btn big" data-act="openClear">合言葉を入力する</button>'
        : '<button class="btn big gold" data-act="cert">3つ達成！ 表彰状を見る →</button>');
  },

  cert() {
    const d = S.data;
    const c = curCard();
    if (!c || clearCount(c) < 3) { setTimeout(() => go('card'), 0); return ''; } // 3つ未満なら card に戻す
    const kid = isKid(c);
    const name = c.kind === 'self' ? d.me.name : c.name;
    const body = kid ? d.texts.certKid : d.texts.certAdult;
    return '<div class="topbar"><button class="back" data-act="openCard">← ミッションカード</button></div>' +
      '<div class="cert">' +
        '<div class="cert-in">' +
          '<div class="cert-ev">第' + esc(d.event.no) + '回 全員集合会</div>' +
          '<h1 class="cert-h">表彰状</h1>' +
          '<div class="cert-name">' + esc(name) + (kid ? ' さん' : ' 殿') + '</div>' +
          '<p class="cert-body">' + nl2br(body) + '</p>' +
          '<div class="cert-foot">' +
            '<div class="cert-sign"><div>' + fmtDate(d.event.date, false) + '</div><div>' + esc(d.texts.signature) + '</div></div>' +
            '<div class="cert-seal">' + (c.cert ? seal('cert', 74, S.justCleared && S.justCleared[c.id + 'cert']) : dotted('ここに<br>社長の<br>認定シール', true)) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      (c.cert
        ? '<p class="hint ok">おめでとう！ 第' + esc(d.event.no) + '回の表彰状が完成しました</p><button class="btn ghost" data-act="openCard">ミッションカードにもどる</button>'
        : '<p class="hint">社長の認定シールをもらおう。' + esc(staffName('cert')) + 'に合言葉を聞いてね</p><button class="btn big gold" data-act="openClear">合言葉を入力する</button>');
  },

  record() {
    const d = S.data;
    const sum = recordSummary();
    const hist = (d.history || []).slice().sort((a, b) => b.no - a.no);
    const items = hist.map(h => {
      const isCur = h.no === d.event.no;
      const status = h.attended
        ? '<span class="stamp">' + flower(46) + '<span>参加</span></span>'
        : isCur ? '<span class="st-cur">今回</span>' : '<span class="st-no">不参加</span>';
      const span = h.start && h.end ? esc(h.start) + '〜' + esc(h.end) : esc(h.start || '');
      const time = span + (h.gather ? (span ? '（集合 ' + esc(h.gather) + '）' : '集合 ' + esc(h.gather)) : '');
      return '<li class="box rec">' +
        '<div class="rec-main">' +
          '<div class="kicker">第' + esc(h.no) + '回</div>' +
          (h.theme ? '<div class="rec-theme">' + esc(h.theme) + '</div>' : '') +
          '<div class="sub">' + fmtDate(h.date, true) + (time ? ' ' + time : '') + '</div>' +
          (h.place ? '<div class="sub">' + esc(h.place) + ' ' + extLink(mapUrl(h.map || h.place), '地図') + '</div>' : '') +
          (safeUrl(h.photoUrl) ? '<div class="photo">' + extLink(h.photoUrl, '写真を見る（Googleドライブ）') + '<div class="note">Lezilyのアカウントで開いてください</div></div>' : '') +
        '</div>' +
        '<div class="rec-st">' + status + '</div>' +
      '</li>';
    }).join('');
    return '<div class="topbar"><button class="back" data-act="home">← ホーム</button></div>' +
      '<h1 class="h1">これまでの参加記録</h1>' +
      '<section class="box">' + summaryHtml(sum) + '</section>' +
      '<ul class="recs">' + items + '</ul>';
  },
};

function summaryHtml(sum) {
  return '<p class="count">' + (sum.first ? 'はじめての全員集合会！' : 'これまでに <b>' + sum.n + '</b> 回 参加') + '</p>' +
    (sum.perfect ? '<span class="badge">皆勤賞</span>' : '');
}

/* ================================================================== */
/* ポップアップ                                                         */
/* ================================================================== */
function renderPopup() {
  const p = S.popup;
  let inner = '';
  if (p.type === 'clear') {
    const list = cards();
    const c = curCard();
    inner = '<h2 class="h2">合言葉を入力</h2>' +
      '<p>実行委員に教えてもらった合言葉を入れてね</p>' +
      '<input id="pass" class="input" type="text" maxlength="50" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-autofocus aria-label="合言葉">' +
      (list.length > 1
        ? '<fieldset class="pick"><legend>CLEARするカード</legend>' + list.map(x =>
            '<label class="check"><input type="checkbox" name="cc" value="' + esc(x.id) + '"' + (x.id === c.id ? ' checked' : '') + '> ' +
            esc(cardLabel(x)) + ' <span class="sub">' + clearCount(x) + '/3</span></label>').join('') + '</fieldset>'
        : '') +
      '<p id="pmsg" class="pmsg" role="alert"></p>' +
      '<button class="btn" data-act="doClear">CLEARする</button>' +
      '<button class="btn ghost" data-act="closePopup">とじる</button>';
  } else if (p.type === 'result') {
    const names = p.okNames;
    const role = p.role;
    const head = role === 'cert' ? '社長認定シールをゲットしました！' : esc(staffName(role)) + 'のシールをゲットしました！';
    inner = (p.okCount
        ? '<div class="celebrate">' + seal(role, 120, true) + '</div>' +
          '<h2 class="h2 center-t">' + head + '</h2>' +
          (names.length > 1 ? '<p class="center-t">' + names.map(n => esc(n) + ' さん').join('、') + ' がゲット！</p>' : '')
        : '<h2 class="h2 center-t">CLEARはありませんでした</h2>') +
      (p.others.length
        ? '<ul class="others">' + p.others.map(o => '<li>' + esc(o.name) + ' さん：' +
            (o.status === 'already' ? 'もうクリア済みです' : '3つクリアしてから、社長の認定をもらってね') + '</li>').join('') + '</ul>'
        : '') +
      '<button class="btn' + (role === 'cert' && p.okCount ? ' gold' : '') + '" data-act="closeResult">' + (role === 'cert' && p.okCount ? '表彰状を見る' : 'OK') + '</button>';
  } else if (p.type === 'addCard') {
    const full = cards().length >= maxCards();
    inner = '<h2 class="h2">家族のカードを追加</h2>' +
      (full
        ? '<p>カードは' + maxCards() + '枚までです</p>'
        : '<p>ご家族の分のミッションカードを作れます。このスマホで一緒に進めてください</p>' +
          '<label class="field">名前<input id="famName" class="input" type="text" maxlength="20" autocomplete="off" data-autofocus></label>' +
          '<fieldset class="pick"><legend>種類</legend>' +
            '<label class="check"><input type="radio" name="kind" value="adult"> 大人</label>' +
            '<label class="check"><input type="radio" name="kind" value="kid"> 子ども</label>' +
          '</fieldset>' +
          '<p id="pmsg" class="pmsg" role="alert"></p>' +
          '<button class="btn" data-act="doAdd">追加する</button>') +
      '<button class="btn ghost" data-act="closePopup">とじる</button>';
  } else if (p.type === 'delete') {
    const c = findCard(p.id);
    inner = '<h2 class="h2">' + esc(c ? c.name : '') + ' さんのカードを削除しますか？</h2>' +
      '<p>こたえとCLEARの記録も見られなくなります</p>' +
      '<p id="pmsg" class="pmsg" role="alert"></p>' +
      '<button class="btn warn" data-act="doDelete">削除する</button>' +
      '<button class="btn ghost" data-act="closePopup" data-autofocus>やめる</button>';
  }
  return '<div class="overlay"><div class="modal" role="dialog" aria-modal="true">' + inner + '</div></div>';
}
function popupMsg(text) {
  const el = document.getElementById('pmsg');
  if (el) el.textContent = text; else toast(text);
}

/* ================================================================== */
/* トースト                                                            */
/* ================================================================== */
let toastTimer = 0;
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ================================================================== */
/* ログイン（Sign in with Google）                                      */
/* ================================================================== */
let loginNonce = '';
let loginTimer = 0;
let loginGen = 0;

window.onGoogleLibraryLoad = () => { if (S.screen === 'login') setupGis(); };

function hasGis() { return !!(window.google && window.google.accounts && window.google.accounts.id); }
function stopLoginTimer() { clearTimeout(loginTimer); loginTimer = 0; loginGen++; }
function setLoginMsg(t) {
  const el = document.getElementById('loginMsg');
  if (el) el.textContent = t || '';
}
function showLoginRetry(on) {
  const b = document.getElementById('loginRetry');
  if (b) b.classList.toggle('hidden', !on);
}

/** nonce を取り直して、ボタンを作り直す（ログイン失敗のあと・9分ごと） */
async function prepareLogin(msg) {
  clearTimeout(loginTimer);
  const gen = ++loginGen;
  loginNonce = '';
  setLoginMsg(msg || '');
  showLoginRetry(false);
  const box = document.getElementById('gsi');
  if (box) box.innerHTML = '';
  let j;
  try { j = await api('nonce'); } catch (_) { j = null; }
  if (gen !== loginGen || S.screen !== 'login') return;
  if (!j || typeof j.nonce !== 'string' || !j.nonce) {
    setLoginMsg(MSG.net);
    showLoginRetry(true);
    return;
  }
  loginNonce = j.nonce;
  loginTimer = setTimeout(() => { if (S.screen === 'login') prepareLogin(''); }, 9 * 60 * 1000);
  setupGis();
}
function setupGis() {
  if (!loginNonce || !hasGis() || S.screen !== 'login') return;
  const box = document.getElementById('gsi');
  if (!box) return;
  window.google.accounts.id.initialize({
    client_id: CONFIG.CLIENT_ID,
    nonce: loginNonce,
    callback: onCredential,
    auto_select: false,
  });
  box.innerHTML = '';
  window.google.accounts.id.renderButton(box, {
    theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ja', width: 260,
  });
}
async function onCredential(resp) {
  if (S.busy) return;
  const token = resp && typeof resp.credential === 'string' ? resp.credential : '';
  if (!token) { prepareLogin(MSG.bad); return; }
  S.busy = true;
  setLoginMsg('ログインしています…');
  let j = null;
  try { j = await api('login', [token]); } catch (_) { j = null; }
  S.busy = false;
  if (j && typeof j.sid === 'string' && j.data) {
    S.sid = j.sid;
    store.set('zp_sid', j.sid);
    setData(j.data);
    go('home');
    return;
  }
  if (j && j.error === 'denied') {
    S.deniedEmail = typeof j.email === 'string' ? j.email : '';
    go('denied');
    return;
  }
  // denied 以外は、必ず nonce を取り直してボタンを作り直す
  prepareLogin(!j ? MSG.net : j.error === 'retry' ? MSG.retry : msgOf(j.error));
}
function toLogin() {
  S.sid = '';
  S.data = null;
  store.set('zp_sid', '');
  store.set('zp_cur', '');
  S.cur = '';
  AQ.forEach(q => clearTimeout(q.timer));
  AQ.clear();
  go('login');
}
function logout() {
  try { sessionStorage.clear(); } catch (_) { /* なし */ }
  try { if (hasGis()) window.google.accounts.id.disableAutoSelect(); } catch (_) { /* なし */ }
  S.deniedEmail = '';
  toLogin();
}

/* ================================================================== */
/* こたえの保存（同じ欄への送信は1件ずつ。最新の値だけを送る）               */
/* ================================================================== */
function onAnswerInput(el) {
  const id = el.dataset.card;
  const idx = Number(el.dataset.idx);
  const value = el.value;
  const c = findCard(id);
  if (c) c.answers[idx - 1] = value;
  const key = id + ':' + idx;
  const q = AQ.get(key) || { timer: 0, sending: false, dirty: false, value: '' };
  q.value = value;
  q.dirty = true;
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flushAnswer(id, idx), 800);
  AQ.set(key, q);
}
async function flushAnswer(id, idx) {
  const key = id + ':' + idx;
  const q = AQ.get(key);
  if (!q || q.sending || !q.dirty) return;
  q.sending = true;
  const v = q.value;
  let ok = false;
  try {
    const j = await api('saveAnswer', [id, idx, v]);
    if (j && j.ok) ok = true;
    else if (j && j.error) toast(msgOf(j.error));
  } catch (e) {
    if (e && e.message === 'expired') return;
    toast(MSG.net);
  } finally {
    q.sending = false;
  }
  if (q.value !== v) { flushAnswer(id, idx); return; } // 送信中に入力が続いた → 最新の値を1回だけ送る
  if (ok) { q.dirty = false; AQ.delete(key); }
}

/* ================================================================== */
/* 操作                                                                */
/* ================================================================== */
const ACTIONS = {
  retryBoot() { boot(); },
  loginRetry() { prepareLogin(''); },
  logout() { logout(); },
  home() { go('home'); },
  place() { go('place'); },
  record() { go('record'); },
  openCard() {
    if (S.screen === 'home') { const s = selfCard(); if (s) setCur(s.id); }
    go('card');
  },
  pick(el) { setCur(el.dataset.id); render(); },
  cert() {
    const c = curCard();
    if (!c || clearCount(c) < 3) { go('card'); return; }
    go('cert');
  },
  addCard() { openPopup({ type: 'addCard' }); },
  askDelete() { const c = curCard(); if (c && c.kind !== 'self') openPopup({ type: 'delete', id: c.id }); },
  openClear() { openPopup({ type: 'clear' }); },
  closePopup() { closePopup(); },
  closeResult() {
    const p = S.popup;
    if (p && p.okIds && p.okIds.length && !p.okIds.includes(S.cur) && findCard(p.okIds[0])) setCur(p.okIds[0]);
    const c = curCard();
    if (p && p.role === 'cert' && p.okCount) go('cert');
    else if (S.screen === 'cert' && c && clearCount(c) >= 3) go('cert');
    else go('card');
    S.justCleared = null;
  },

  async doAdd() {
    const nameEl = document.getElementById('famName');
    const kindEl = document.querySelector('input[name=kind]:checked');
    const name = nameEl ? nameEl.value.trim() : '';
    const n = Array.from(name).length;
    if (n < 1 || n > 20 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) { popupMsg('名前を1〜20文字で入力してください'); return; }
    if (!kindEl) { popupMsg('「大人」か「子ども」を選んでください'); return; }
    await withBusy(async () => {
      const j = await api('addCard', [name, kindEl.value]);
      if (j && j.error) { popupMsg(msgOf(j.error)); return; }
      setData(j.data);
      if (findCard(j.id)) setCur(j.id);
      S.popup = null;
      go('card');
    });
  },

  async doDelete() {
    const id = S.popup && S.popup.id;
    if (!id) return;
    await withBusy(async () => {
      const j = await api('deleteCard', [id]);
      if (j && j.error) { popupMsg(msgOf(j.error)); return; }
      setData(j.data);
      const s = selfCard();
      if (s) setCur(s.id);
      go('card');
    });
  },

  async doClear() {
    const passEl = document.getElementById('pass');
    const pass = passEl ? passEl.value : '';
    const n = Array.from(pass).length;
    if (!pass.trim() || n > 50) { popupMsg('合言葉を入力してね'); return; }
    let ids;
    const boxes = document.querySelectorAll('input[name=cc]');
    if (boxes.length) ids = Array.from(boxes).filter(b => b.checked).map(b => b.value);
    else ids = curCard() ? [curCard().id] : [];
    if (!ids.length) { popupMsg('CLEARするカードを選んでね'); return; }
    await withBusy(async () => {
      const j = await api('clear', [ids, pass]);
      if (j && j.error) { popupMsg(msgOf(j.error)); return; }
      const nameOf = id => { const c = (j.data.cards || []).find(x => x.id === id); return c ? c.name : ''; };
      setData(j.data);
      const results = Array.isArray(j.results) ? j.results : [];
      const ok = results.filter(r => r.status === 'ok');
      const role = (results[0] && results[0].role) || 'M1';
      S.justCleared = {};
      ok.forEach(r => { S.justCleared[r.id + r.role] = true; });
      S.popup = {
        type: 'result', role: role, okCount: ok.length,
        okIds: ok.map(r => r.id), okNames: ok.map(r => nameOf(r.id)),
        others: results.filter(r => r.status !== 'ok').map(r => ({ name: nameOf(r.id), status: r.status })),
      };
      render();
    });
  },
};

function onClick(ev) {
  const el = ev.target.closest('[data-act]');
  if (!el || !document.getElementById('app').contains(el)) return;
  const act = el.dataset.act;
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, act) ? ACTIONS[act] : null;
  if (!fn) return;
  if (el.tagName === 'BUTTON' || el.tagName === 'A' && !el.getAttribute('href')) ev.preventDefault();
  if (S.busy && el.tagName === 'BUTTON') return;
  fn(el);
}
function onInput(ev) {
  const el = ev.target;
  if (el && el.classList && el.classList.contains('ans')) onAnswerInput(el);
}
function onKey(ev) {
  if (ev.key !== 'Enter' || ev.isComposing) return;
  const id = ev.target && ev.target.id;
  if (id === 'pass') { ev.preventDefault(); ACTIONS.doClear(); }
  else if (id === 'famName') { ev.preventDefault(); }
}

/* ================================================================== */
/* 起動                                                                */
/* ================================================================== */
async function boot() {
  S.bootError = false;
  S.sid = store.get('zp_sid');
  S.cur = store.get('zp_cur');
  if (!S.sid) { go('login'); return; }
  S.screen = 'boot';
  render();
  let j;
  try { j = await api('bootstrap'); }
  catch (e) {
    if (e && e.message === 'expired') return;
    S.bootError = true; render(); return;
  }
  if (!j || j.error) {
    if (j && j.error === 'denied') { toLogin(); toast(MSG.denied); return; }
    S.bootError = true; render(); toast(msgOf(j && j.error)); return;
  }
  setData(j);
  go('home');
}

function init() {
  const app = document.getElementById('app');
  app.addEventListener('click', onClick);
  app.addEventListener('input', onInput);
  app.addEventListener('keydown', onKey);
  boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
