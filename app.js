'use strict';
/*
 * 全員集合会パスポート — 画面（GitHub Pages）
 * このファイルには、人名・日付・場所・文面・合言葉などの固有の情報を書かない。
 * すべてログイン後に API から受け取る。
 */
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbztUcoOaQIWsNumgEbnBcWHF0160vQye3eG9gt3U8XyVtgSYEuzitBa01pVFYe9ZWA/exec', // Apps Script の「ウェブアプリ」URL（/dev ではなく /exec）
  CLIENT_ID: '417170064468-r6fshqd1spp0fqlb9088a2i976bl6f4q.apps.googleusercontent.com',
};

/* ================================================================== */
/* 状態・保存                                                          */
/* ================================================================== */
const S = { sid: '', data: null, cur: '', screen: 'boot', popup: null, busy: false, deniedEmail: '', bootError: false, past: null, roundNo: 0, roundFrom: 'record', pkey: '' };
const PAST = new Map(); // 過去の年の応答（メモリだけ。保存しない）

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
  notopen: 'いまは合言葉を受け付けていません',
  needcheckin: '受付で参加の合言葉を入れると、ミッションカードが開きます',
  busy: '少し待ってから、もう一度ためしてね',
  retry: 'もう一度ログインしてください',
  net: '通信できませんでした。電波のよいところで、もう一度ためしてね',
  linkoff: 'このQRは使えなくなりました',
};
/** 子どものカードで合言葉を入れたときの文言（ひらがな） */
const KID_MSG = {
  wrongcode: 'あいことばが ちがうよ。もういちど たしかめてね',
  notopen: 'いまは あいことばを うけつけていないよ',
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
/** 5-5：顔写真は data:image/(jpeg|png|webp);base64,… だけを使う */
function safePhoto(p) {
  return typeof p === 'string' && p.length <= 45000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(p) ? p : '';
}
function nl2br(s) { return esc(s).replace(/\r?\n/g, '<br>'); }
/** テーマ（{漢字|かな} のルビ書きができる。子どもの画面だけルビを出し、ほかは漢字だけ） */
function themeHtml(t, kid) { return String(t || '').trim().split(/[\s　]+/).filter(Boolean).map(w => rubyText(w, kid)).join('<br>'); }
/** ルビ書き {漢字|かな} を外した文字（ルビを出さないところ用） */
function plain(s) { return String(s || '').replace(/\{([^{}|<>]+)\|([^{}|<>]+)\}/g, '$1'); }
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
  if (j && j.error === 'linkoff' && S.pkey) { endPartner(); throw new Error('expired'); }
  return j;
}

/** 送信中は二重送信を防ぐ（ボタンを無効化） */
/** 押したボタンの文字を「たしかめています…」にする（戻すときは返した関数を呼ぶ） */
function busyLabel(act, text) {
  const b = document.querySelector('[data-act="' + act + '"]');
  if (!b) return () => {};
  const old = b.textContent;
  b.textContent = text;
  return () => { if (document.body.contains(b)) b.textContent = old; };
}
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
      const w = AQ.get(c.id + ':w' + i);
      if (w && w.dirty) { if (!Array.isArray(c.whos)) c.whos = ['', '', '']; c.whos[i - 1] = w.value; }
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
function staffOf(role, list) { return (list || (S.data && S.data.staff) || []).find(s => s.role === role) || null; }
/** ミッションの担当3人の名前（あだなを「・」でつなぐ） */
function missionStaffNames(list) { return ['M1', 'M2', 'M3'].map(r => staffName(r, list)).join('・'); }
function staffName(role, list) { const s = staffOf(role, list); return s && s.name ? s.name : (role === 'cert' ? '社長' : '実行委員'); }
function missionsFor(c) { return (c && Array.isArray(c.missions)) ? c.missions : []; }
function cardLabel(c) { return c.name || ''; }

/** 参加回数（今回より前の参加数＋1）と皆勤賞 */
function recordSummary() {
  const d = S.data;
  const cur = d.event.no;
  // 1.5回のような特別な回は、参加回数・皆勤賞には数えない（整数の回だけ）
  const hist = (d.history || []).filter(h => Number.isInteger(h.no));
  const before = hist.filter(h => h.no < cur);
  const n = before.filter(h => h.attended).length + (d.event.attended ? 1 : 0);
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
/** 実行委員の顔シール（写真）。写真がない・形式が違うときは頭文字 */
function face(st, size) {
  const s = st || {};
  const cert = s.role === 'cert';
  const ring = safeColor(s.color, cert ? '#C99A2E' : '#E8892F');
  const photo = safePhoto(s.photo);
  const edge = cert ? 'background:linear-gradient(135deg,#7D5C18 0%,#E9CF7A 20%,#B8892E 38%,#FBEFB8 52%,#A87C2A 68%,#E8C870 84%,#6E4F12 100%)' : 'background:' + ring;
  const inner = photo
    ? '<img src="' + esc(photo) + '" alt="' + esc(s.name || '') + '">'
    : '<span class="face-ini" style="background:' + ring + ';font-size:' + Math.round(size * 0.42) + 'px">' + esc(firstChar(s.name)) + '</span>';
  return '<span class="face" style="width:' + size + 'px;height:' + size + 'px;' + edge + '">' + inner + '</span>';
}
/** 社長の認定シールの下の帯「社長 ○○」用（表示名の最後の「さん」などを除く） */
function bareName(n) { return String(n || '').trim().replace(/(さん|くん|君|ちゃん|様|さま)$/, '') || '社長'; }
function seal(role, size, pop, list, kid) {
  const st = staffOf(role, list) || { role };
  const cert = role === 'cert';
  const c = safeColor(st.color, cert ? '#C99A2E' : '#E8892F');
  const fs = Math.max(10, Math.round(size * 0.16)) + 'px';
  if (cert) {
    // 紙の認定シールと同じつくり：上に「認定」、下に「社長 ○○」（金色の帯）
    const nm = bareName(st.name);
    return '<span class="seal gold' + (pop ? ' pop' : '') + '" style="--fs:' + fs + '">' +
      '<span class="seal-label seal-top">' + kt('{認|にん}{定|てい}', kid) + '</span>' + face(st, size) +
      '<span class="seal-label">' + kt(nm === '社長' ? '{社|しゃ}{長|ちょう}' : '{社|しゃ}{長|ちょう} ' + esc(nm), kid) + '</span></span>';
  }
  return '<span class="seal' + (pop ? ' pop' : '') + '" style="--fs:' + fs + '">' + face(st, size) +
    '<span class="seal-label" style="background:' + c + '">' + (kid ? kt(CLEAR_K, kid) + '!' : 'CLEAR!') + '</span></span>';
}
function joinStamp(size) {
  return '<img class="join-stamp" src="stamp_join.png" width="' + size + '" height="' + size + '" alt="参加">';
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
  const pc = S.past && S.past.data && (S.past.data.cards || []).find(x => x.id === S.past.cur);
  app.dataset.kid = ((S.screen === 'card' || S.screen === 'cert') && isKid(curCard())) ||
    ((S.screen === 'pastCard' || S.screen === 'pastCert') && isKid(pc)) ? '1' : '';
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
      // 表紙：パスポート手帳の形（ロゴは白い窓の上に置く。ダークモードでも読めるように）
      // ログインすると、表紙が左にひらいて中のページが見えてからホームへ（openCover）
      '<div class="pp-book">' +
        '<div class="pp-page" aria-hidden="true"><span>ようこそ！</span><small class="pp-wait">よみこみ中…</small></div>' +
        '<div class="pp-cover">' +
          '<div class="pp-logo"><img src="logo_lezily.png" width="78" height="81" alt="Lezily レジリー"></div>' +
          '<div class="pp-en" aria-hidden="true">PASSPORT</div>' +
          '<h1 class="pp-title">全員集合会<span>パスポート</span></h1>' +
          '<div class="pp-stars" aria-hidden="true">★ ★ ★</div>' +
        '</div>' +
      '</div>' +
      '<p class="lead">Lezilyのメンバーは、Googleアカウントでログインしてください</p>' +
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
    const sum = recordSummary();
    const attend = ev.attended
      ? '<div class="attend"><span class="stamp">' + joinStamp(56) + '</span><span>参加の記録がつきました</span></div>' +
        '<button class="link-btn" data-act="openRound" data-from="home" data-no="' + esc(ev.no) + '">第' + esc(ev.no) + '回のページを見る →</button>'
      : ev.checkinOpen
        ? '<button class="btn big" data-act="openCheckin">参加の合言葉を入れる</button>'
        : '';
    return '' +
      '<header class="hello' + (safePhoto(d.homeArt) ? ' over-art' : '') + '">' +
        // 絵の人たちが言っている吹き出し（本名は出さない）
        '<div class="hello-t"><span class="nb">' + esc(hello) + '、</span><span class="nb">ようこそ！</span></div>' +
      '</header>' +
      (safePhoto(d.homeArt) ? '<img class="home-art" src="' + esc(safePhoto(d.homeArt)) + '" alt="みんなでばんざいしているイラスト">' : '') +

      '<section class="box event">' +
        '<div class="kicker">第' + esc(ev.no) + '回 全員集合会</div>' +
        (ev.theme ? '<h1 class="theme">' + themeHtml(ev.theme) + '</h1>' : '') +
        '<dl class="info">' +
          (ev.date ? '<div><dt>日にち</dt><dd>' + fmtDate(ev.date, true) + '</dd></div>' : '') +
          (ev.gather ? '<div><dt>集合</dt><dd>' + esc(ev.gather) + '</dd></div>' : '') +
        '</dl>' +
        // 場所はホームには出さない回もある（設定 HOME_PLACE）。回のページにはいつも出る
        (ev.place && ev.homePlace ? '<button class="link-btn" data-act="place">場所を見る →</button>' : '') +
        extLink(ev.detailUrl, '当日の詳しいご案内を見る', 'link block') +
        attend +
        // ミッションカードは、参加の合言葉を入れてから開く（10/26）
        (ev.cards
          ? (ev.attended
            ? '<button class="btn big" data-act="openCard">第' + esc(ev.no) + '回 ミッションカードを開く</button>'
            : '<p class="hint">' + (ev.checkinOpen ? '参加の合言葉を入れると、第' + esc(ev.no) + '回のミッションカードが開きます' : '第' + esc(ev.no) + '回のミッションカードは、当日 受付で参加の合言葉を入れると開きます') + '</p>')
          : '') +
      '</section>' +

      '<section class="box">' +
        '<h2 class="h2">参加記録</h2>' + summaryHtml(sum) +
        '<button class="link-btn" data-act="record">参加記録を見る →</button>' +
      '</section>' +

      '';
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
    const list = cards();
    const chips = list.map(x =>
      '<button class="chip' + (x.id === c.id ? ' on' : '') + '" data-act="pick" data-id="' + esc(x.id) + '" aria-pressed="' + (x.id === c.id) + '">' +
        '<span class="chip-n">' + esc(cardLabel(x)) + '</span><span class="chip-c">' + clearCount(x) + '/3</span></button>').join('') +
      (list.length < maxCards()
        ? '<button class="chip add" data-act="addCard"><span>' + kt('＋ {家|か}{族|ぞく}のカード', kid) + '</span></button>'
        : '<span class="chip-max">' + kt('カードは' + maxCards() + '{枚|まい}までです', kid) + '</span>');

    const missionHtml = missionRows(c, null, true);
    const shared = c.kind === 'adult' && c.shareUntil;

    if (S.pkey) {
      return '<div class="pbar">' + (d.owner && d.owner.nick ? esc(d.owner.nick) + 'から届いた' : '') + esc(c.name) + ' さんのカードです</div>' +
        (d.event.theme ? '<div class="theme small">' + themeHtml(d.event.theme) + '</div>' : '') +
        '<h1 class="h1 center-t">ミッションカード</h1>' +
        '<p class="lead">3つクリアしたら表彰状がひらきます</p>' +
        missionHtml +
        (n < 3
          ? '<p class="hint">' + 'こたえを書いたら、' + esc(missionStaffNames()) + 'のだれかに合言葉を聞いて、そのミッションの欄に入れてね（同じ人は1回まで）' + '（' + n + '/3 クリア）</p>'
          : '<button class="btn big gold" data-act="cert">3つ達成！ 表彰状を見る →</button>') +
        '<p class="note center-t">このカードは今日の23:59まで使えます</p>';
    }

    return '<div class="topbar"><button class="back" data-act="home">← ホーム</button></div>' +
      (d.event.theme ? '<div class="theme small">' + themeHtml(d.event.theme, kid) + '</div>' : '') +
      '<h1 class="h1 center-t">ミッションカード</h1>' +
      '<div class="chips" role="group" aria-label="カードの切り替え">' + chips + '</div>' +
      (c.kind !== 'self'
        ? '<div class="owner"><span>' + esc(c.name) + ' さんのカード</span><button class="mini" data-act="askDelete">' + kt('このカードを{削|さく}{除|じょ}', kid) + '</button></div>'
        : '') +
      (c.kind === 'adult'
        ? '<button class="share-btn" data-act="openShare">' + (shared ? esc(c.name) + ' さんのスマホで使用中（QRを見る・止める）' : esc(c.name) + ' さんのスマホでも使う') + '</button>'
        : '') +
      '<p class="lead">' + (kid ? '3つ クリアしたら ひょうしょうじょうが ひらくよ' : '3つクリアしたら表彰状がひらきます') + '</p>' +
      missionHtml +
      (n < 3
        ? '<p class="hint">' + (kid ? 'こたえを かいたら、ちかくの おとなに おしえてね（' + n + '/3 クリア）' : 'こたえを書いたら、' + esc(missionStaffNames()) + 'のだれかに合言葉を聞いて、そのミッションの欄に入れてね（同じ人は1回まで）（' + n + '/3 クリア）') + '</p>'
        : '<button class="btn big gold" data-act="cert">' + kt('3つ{達|たっ}{成|せい}！ {表|ひょう}{彰|しょう}{状|じょう}を{見|み}る →', kid) + '</button>');
  },

  cert() {
    const d = S.data;
    const c = curCard();
    const kid = isKid(c);
    if (!c || clearCount(c) < 3) { setTimeout(() => go('card'), 0); return ''; } // 3つ未満なら card に戻す
    return '<div class="topbar"><button class="back" data-act="openCard">← ミッションカード</button></div>' +
      certHtml(c, d.me.name, d.event, d.texts, null, S.justCleared && S.justCleared[c.id + 'cert']) +
      (c.cert
        ? '<p class="hint ok">' + kt('おめでとう！ {第|だい}' + esc(d.event.no) + '{回|かい}の{表|ひょう}{彰|しょう}{状|じょう}が{完|かん}{成|せい}しました', kid) + '</p><button class="btn ghost" data-act="openCard">ミッションカードにもどる</button>'
        : '<p class="hint">' + kt('{社|しゃ}{長|ちょう}の{認|にん}{定|てい}スタンプをもらおう。', kid) + esc(staffName('cert')) + kt('に{合|あい}{言|こと}{葉|ば}を{聞|き}いてね', kid) + '</p><button class="btn big gold" data-act="openClear">' + kt('{合|あい}{言|こと}{葉|ば}を{入|にゅう}{力|りょく}する', kid) + '</button>');
  },

  record() {
    const d = S.data;
    const sum = recordSummary();
    const hist = (d.history || []).slice().sort((a, b) => b.no - a.no);
    const items = hist.map(h => {
      const isCur = h.no === d.event.no;
      return '<li><button class="box rec" data-act="openRound" data-no="' + esc(h.no) + '">' +
        '<span class="rec-main">' +
          '<span class="kicker">第' + esc(h.no) + '回' + (isCur ? '（今回）' : '') + '</span>' +
          (h.theme ? '<span class="rec-theme">' + esc(plain(h.theme)) + '</span>' : '') +
          '<span class="sub">' + fmtDate(h.date, true) + '</span>' +
          '<span class="rec-more">写真・くわしく見る →</span>' +
        '</span>' +
        '<span class="rec-st">' + roundStatus(h, isCur) + '</span>' +
      '</button></li>';
    }).join('');
    return '<div class="topbar"><button class="back" data-act="home">← ホーム</button></div>' +
      '<h1 class="h1">これまでの参加記録</h1>' +
      '<section class="box">' + summaryHtml(sum) + '</section>' +
      '<ul class="recs">' + items + '</ul>';
  },

  /* パートナー用QRが使えなくなったとき */
  plink() {
    return '<div class="login">' +
      '<h1 class="title">全員集合会パスポート</h1>' +
      '<div class="box"><h2 class="h2">このQRは使えなくなりました</h2>' +
      '<p>QRが使えるのは、出した日の23:59までです。続けるときは、Lezilyのメンバーの方に、もう一度QRを出してもらってください</p></div>' +
    '</div>';
  },

  /* 参加記録の1回分：くわしい情報・写真・ミッションカード */
  round() {
    const d = S.data;
    const h = (d.history || []).find(x => x.no === S.roundNo);
    if (!h) { setTimeout(() => go('record'), 0); return ''; }
    const isCur = h.no === d.event.no;
    const span = h.start && h.end ? esc(h.start) + '〜' + esc(h.end) : esc(h.start || '');
    const time = span + (h.gather ? (span ? '（集合 ' + esc(h.gather) + '）' : '集合 ' + esc(h.gather)) : '');
    const nCards = Number(h.cards) || 0;
    const cardBtn = isCur
      ? (!d.event.cards ? ''
        : d.event.attended ? '<button class="btn" data-act="openCard">ミッションカードを開く</button>'
        : d.event.checkinOpen ? '<p class="hint">参加の合言葉を入れると、ミッションカードが開きます</p><button class="btn" data-act="openCheckin">参加の合言葉を入れる</button>'
        : '<p class="hint">当日 受付で参加の合言葉を入れると、ミッションカードが開きます</p>')
      : nCards > 0
        ? '<button class="btn" data-act="openPast" data-no="' + esc(h.no) + '">ミッションカードを見る（' + nCards + '枚）</button>'
        : '';
    const photo = safeUrl(h.photoUrl)
      ? photoLink(h.photoUrl, true, h.no) + '<p class="note">Googleドライブで開きます。Lezilyのアカウントで開いてください</p>'
      : '<p class="sub">写真はまだありません</p>';
    // 戻るは、来たところへ（ホームから来たらホーム、参加記録から来たら参加記録）
    const back = S.roundFrom === 'home'
      ? '<button class="back" data-act="home">← ホーム</button>'
      : '<button class="back" data-act="record">← 参加記録</button>';
    const photoBox = '<section class="box"><h2 class="h2">写真・動画</h2>' + photo + '</section>';
    const cardBox = cardBtn ? '<section class="box"><h2 class="h2">ミッションカード</h2>' + cardBtn + '</section>' : '';
    return '<div class="topbar">' + back + '</div>' +
      '<section class="box round-head">' +
        '<div class="rec-main">' +
          '<div class="kicker">第' + esc(h.no) + '回 全員集合会</div>' +
          (h.theme ? '<h1 class="h1 round-theme">' + themeHtml(h.theme) + '</h1>' : '') +
          '<div class="sub">' + fmtDate(h.date, true) + (time ? ' ' + time : '') + '</div>' +
          (h.place ? '<div class="sub">' + esc(h.place) + ' ' + extLink(mapUrl(h.map || h.place), '地図') + '</div>' : '') +
        '</div>' +
        '<div class="rec-st">' + roundStatus(h, isCur) + '</div>' +
      '</section>' +
      // 今回の回はミッションカードが上（当日よく使う）。過去の回は写真が上
      (isCur ? cardBox + photoBox : photoBox + cardBox);
  },

  /* 4-12：過去の年（見るだけ） */
  pastCard() {
    const p = S.past;
    if (!p || !p.data) { setTimeout(() => go('record'), 0); return ''; }
    const d = p.data;
    const list = d.cards || [];
    const c = list.find(x => x.id === p.cur) || list[0];
    if (!c) return '<div class="topbar"><button class="back" data-act="roundBack">← もどる</button></div><p>' + esc(MSG.notfound) + '</p>';
    const kid = isKid(c);
    const chips = list.map(x =>
      '<button class="chip' + (x.id === c.id ? ' on' : '') + '" data-act="pickPast" data-id="' + esc(x.id) + '" aria-pressed="' + (x.id === c.id) + '">' +
        '<span class="chip-n">' + esc(cardLabel(x)) + '</span><span class="chip-c">' + clearCount(x) + '/3</span></button>').join('');
    return '<div class="topbar"><button class="back" data-act="roundBack">' + kt('← {第|だい}' + esc(d.event.no) + '{回|かい}にもどる', kid) + '</button></div>' +
      '<div class="kicker center-t">' + kt('{第|だい}' + esc(d.event.no) + '{回|かい}', kid) + '</div>' +
      (d.event.theme ? '<div class="theme small">' + themeHtml(d.event.theme, kid) + '</div>' : '') +
      '<h1 class="h1 center-t">ミッションカード</h1>' +
      '<div class="chips" role="group" aria-label="カードの切り替え">' + chips + '</div>' +
      (c.kind !== 'self' ? '<div class="owner"><span>' + esc(c.name) + ' さんのカード</span></div>' : '') +
      missionRows(c, d.staff || [], false) +
      (clearCount(c) >= 3
        ? '<button class="btn big gold" data-act="pastCert">' + (kid ? kt('{表|ひょう}{彰|しょう}{状|じょう}を{見|み}る →', kid) : '表彰状を見る →') + '</button>'
        : '');
  },

  pastCert() {
    const p = S.past;
    const d = p && p.data;
    const c = d && (d.cards || []).find(x => x.id === p.cur);
    if (!c || clearCount(c) < 3) { setTimeout(() => go(d ? 'pastCard' : 'record'), 0); return ''; }
    const selfName = c.kind === 'self' ? (S.data && S.data.me.name) || c.name : c.name;
    return '<div class="topbar"><button class="back" data-act="pastCardBack">← ミッションカードにもどる</button></div>' +
      certHtml(c, selfName, d.event, d.texts || {}, d.staff || [], false) +
      '<button class="btn ghost" data-act="pastCardBack">ミッションカードにもどる</button>';
  },
};

/** ミッション3つ。editable=false のときは見るだけ（こたえは文字で表示、未CLEARは文言なしの点線） */
function missionRows(c, staffList, editable) {
  const kid = isKid(c);
  const ms = missionsFor(c);
  return [0, 1, 2].map(i => {
    const m = ms[i] || { who: '', label: '', q: '', color: '#E8892F' };
    const role = 'M' + (i + 1);
    const st = staffOf(role, staffList);
    const sc = safeColor(st && st.color, '#E8892F');
    const mc = safeColor(m.color, '#E8892F');
    const done = !!(c.clears || [])[i];
    const ans = (c.answers || [])[i] || '';
    const who = (c.whos || [])[i] || '';
    const whoHtml = editable
      ? '<label class="who-row"><span class="who-l">' + (kid ? kt('きいた{人|ひと}', kid) : '聞いた人') + '</span>' +
          '<input class="who" type="text" maxlength="20" autocomplete="off" data-card="' + esc(c.id) + '" data-idx="' + (i + 1) + '" placeholder="' +
          (kid ? 'だれに きいた？' : '話を聞いた人の名前') + '" aria-label="MISSION ' + (i + 1) + ' で話を聞いた人" value="' + esc(who) + '"></label>'
      : (who ? '<p class="who-view"><span class="who-l">' + (kid ? kt('きいた{人|ひと}', kid) : '聞いた人') + '</span>' + esc(who) + '</p>' : '');
    const answerHtml = editable
      ? '<textarea class="ans" rows="2" maxlength="200" data-card="' + esc(c.id) + '" data-idx="' + (i + 1) + '" placeholder="' +
          (kid ? 'こたえをかこう' : '聞いたことをメモ') + '" aria-label="MISSION ' + (i + 1) + ' のこたえ">' + esc(ans) + '</textarea>'
      : (ans ? '<p class="ans-view">' + esc(ans) + '</p>' : '');
    // 11/2：どのミッションも M1〜M3 のだれでもCLEARできる。シールはCLEARした人の顔
    const by = (c.clearBy || [])[i] || role;
    const slot = done
      ? seal(by, 62, editable && S.justCleared && S.justCleared[c.id + role], staffList, kid)
      : editable ? dotted(kid ? kt(CLEAR_K, kid) : 'CLEAR') : dotted('');
    return '<div class="mission' + (done ? ' done' : '') + '">' +
      '<div class="m-main">' +
        '<div class="m-no" style="color:' + sc + '">' + (kid ? kt(MISSION_K, kid) : 'MISSION') + ' ' + (i + 1) + '</div>' +
        '<p class="m-text">' +
          '<span class="tag" style="background:' + sc + '">' + (kid ? 'だれに' : '誰に') + '</span> ' + rubyText(m.who, kid) + '<br>' +
          (m.label ? '<span class="tag" style="background:' + mc + '">' + rubyText(m.label, kid) + '</span> ' : '') + rubyText(m.q, kid) +
        '</p>' +
        whoHtml +
        answerHtml +
        // ミッションごとに合言葉を入れる（11/2：下の1か所だけだと分かりにくい）
        (editable && !done
          ? '<button class="m-pass" data-act="openClear" data-idx="' + (i + 1) + '">' + (kid ? 'あいことばを いれる' : '合言葉を入れる') + '</button>'
          : '') +
      '</div>' +
      '<div class="m-slot">' + slot + '</div>' +
    '</div>';
  }).join('');
}

/** ルビ（子どもの表彰状用）。文面シートでは {漢字|かな} と書く。大人の表彰状では漢字だけを出す */
function rb(base, ruby) { return '<ruby>' + esc(base) + '<rt>' + esc(ruby) + '</rt></ruby>'; }
function rubyText(s, kid) {
  return nl2br(s).replace(/\{([^{}|<>]+)\|([^{}|<>]+)\}/g, (m, base, ruby) => kid ? '<ruby>' + base + '<rt>' + ruby + '</rt></ruby>' : base);
}
/** 子どもの画面の文言：{漢字|かな} をルビにする（大人の画面では漢字だけ）。s は HTML として安全な文字列 */
function kt(s, kid) { return String(s).replace(/\{([^{}|<>]+)\|([^{}|<>]+)\}/g, (m, base, ruby) => kid ? '<ruby>' + base + '<rt>' + ruby + '</rt></ruby>' : base); }
const MISSION_K = '{MISSION|ミッション}';
const CLEAR_K = '{CLEAR|クリア}';
function kidDate(s) {
  const p = parseDate(s);
  if (!p) return esc(s || '');
  return p.y + rb('年', 'ねん') + p.mo + rb('月', 'がつ') + p.d + rb('日', 'にち');
}

/** 表彰状の本体（今回・過去の年で共通） */
function certHtml(c, selfName, ev, texts, staffList, pop) {
  const kid = isKid(c);
  const name = c.kind === 'self' ? selfName : c.name;
  const body = kid ? texts.certKid : texts.certAdult;
  return '<div class="cert">' +
    '<div class="cert-in">' +
      '<div class="cert-ev">' + (kid
        ? rb('第', 'だい') + esc(ev.no) + rb('回', 'かい') + ' ' + rb('全員集合会', 'ぜんいんしゅうごうかい')
        : '第' + esc(ev.no) + '回 全員集合会') + '</div>' +
      '<h1 class="cert-h">' + (kid ? rb('表彰状', 'ひょうしょうじょう') : '表彰状') + '</h1>' +
      '<div class="cert-name">' + esc(name) + (kid ? ' さん' : ' 殿') + '</div>' +
      '<p class="cert-body">' + rubyText(body || '', kid) + '</p>' +
      '<div class="cert-foot">' +
        '<div class="cert-sign"><div>' + (kid ? kidDate(ev.date) : fmtDate(ev.date, false)) + '</div><div>' + rubyText(texts.signature || '', kid) + '</div></div>' +
        '<div class="cert-seal">' + (c.cert ? seal('cert', 74, pop, staffList, kid) : dotted(staffList ? '' : kt('ここに<br>{社|しゃ}{長|ちょう}の<br>{認|にん}{定|てい}スタンプ', kid), true)) + '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function roundStatus(h, isCur) {
  return h.attended
    ? '<span class="stamp">' + joinStamp(56) + '</span>'
    : isCur ? '<span class="st-cur">今回</span>' : '<span class="st-no">不参加</span>';
}
/** 写真フォルダへのリンク。注意書き（文面シートの photo_note）があれば、先に確認を出す */
function photoNote(no) {
  const h = no ? (S.data && S.data.history || []).find(x => x.no === no) : null;
  return (h && h.photoNote) || (S.data && S.data.texts && S.data.texts.photoNote) || '';
}
/** 写真フォルダへのリンク。注意書き（回シートの「写真の注意書き」、なければ文面シートの photo_note）があれば、先に確認を出す */
function photoLink(url, big, no) {
  const u = safeUrl(url);
  if (!u) return '';
  const label = big ? '写真・動画を見る' : '写真・動画を見る（Googleドライブ）';
  if (!photoNote(no)) return extLink(u, label, big ? 'btn' : 'link');
  return '<button class="' + (big ? 'btn' : 'link-btn') + '" data-act="openPhoto" data-url="' + esc(u) + '" data-no="' + esc(no || '') + '">' + label + '</button>';
}

/** QRコード（qr.js の qrcode を使う。SVG の文字列） */
function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '<p class="pre">' + esc(text) + '</p>';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  return '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QRコード" shape-rendering="crispEdges">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

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
    const kidC = c && isKid(c);
    inner = (p.idx
      ? '<h2 class="h2">' + (kidC ? kt(MISSION_K, true) : 'MISSION') + ' ' + p.idx + ' の' + (kidC ? 'あいことば' : '合言葉') + '</h2>' +
        '<p>' + esc(missionStaffNames()) + (kidC ? 'の だれかに おしえてもらった あいことばを いれてね' : 'のだれかに教えてもらった合言葉を入れてね（同じ人は1回まで）') + '</p>'
      : '<h2 class="h2">' + kt('{合|あい}{言|こと}{葉|ば}を{入|にゅう}{力|りょく}', kidC) + '</h2>' +
        '<p>' + kt('{実|じっ}{行|こう}{委|い}{員|いん}に{教|おし}えてもらった{合|あい}{言|こと}{葉|ば}を{入|い}れてね', kidC) + '</p>') +
      '<input id="pass" class="input" type="text" maxlength="50" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-autofocus aria-label="合言葉">' +
      (list.length > 1
        ? '<fieldset class="pick"><legend>' + (kidC ? kt(CLEAR_K, true) : 'CLEAR') + 'するカード</legend>' + list.map(x =>
            '<label class="check"><input type="checkbox" name="cc" value="' + esc(x.id) + '"' + (x.id === c.id ? ' checked' : '') + '> ' +
            esc(cardLabel(x)) + ' <span class="sub">' + clearCount(x) + '/3</span></label>').join('') + '</fieldset>'
        : '') +
      '<p id="pmsg" class="pmsg" role="alert"></p>' +
      '<button class="btn" data-act="doClear">' + (kidC ? kt(CLEAR_K, true) : 'CLEAR') + 'する</button>' +
      '<button class="btn ghost" data-act="closePopup">とじる</button>';
  } else if (p.type === 'result') {
    const names = p.okNames;
    const role = p.role;
    const k = !!p.kid;
    const head = role === 'cert' ? kt('{社|しゃ}{長|ちょう}{認|にん}{定|てい}スタンプをゲットしました！', k) : esc(staffName(role)) + 'のスタンプをゲットしました！';
    inner = (p.okCount
        ? '<div class="celebrate">' + seal(role, 120, true, null, k) + '</div>' +
          '<h2 class="h2 center-t">' + head + '</h2>' +
          (names.length > 1 ? '<p class="center-t">' + names.map(n => esc(n) + ' さん').join('、') + ' がゲット！</p>' : '')
        : '<h2 class="h2 center-t">' + (k ? kt(CLEAR_K, k) : 'CLEAR') + 'はありませんでした</h2>') +
      (p.others.length
        ? '<ul class="others">' + p.others.map(o => '<li>' + esc(o.name) + ' さん：' +
            statusMsg(o) + '</li>').join('') + '</ul>'
        : '') +
      '<button class="btn' + (role === 'cert' && p.okCount ? ' gold' : '') + '" data-act="closeResult">' + (role === 'cert' && p.okCount ? kt('{表|ひょう}{彰|しょう}{状|じょう}を{見|み}る', k) : 'OK') + '</button>';
  } else if (p.type === 'checkin') {
    inner = '<h2 class="h2">参加の合言葉</h2>' +
      '<p>受付で教えてもらった合言葉を入れてね</p>' +
      '<input id="cpass" class="input" type="text" maxlength="50" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-autofocus aria-label="参加の合言葉">' +
      '<p id="pmsg" class="pmsg" role="alert"></p>' +
      '<button class="btn" data-act="doCheckin">参加する</button>' +
      '<button class="btn ghost" data-act="closePopup">とじる</button>';
  } else if (p.type === 'checked') {
    inner = '<div class="celebrate"><span class="stamp big">' + joinStamp(140) + '</span></div>' +
      '<h2 class="h2 center-t">' + (p.already ? 'もう参加の記録がついています' : '参加の記録がつきました！') + '</h2>' +
      '<p class="center-t">第' + esc(S.data.event.no) + '回 全員集合会へようこそ</p>' +
      (S.data.event.cards ? '<p class="center-t">ミッションカードが開きました！</p>' : '') +
      '<button class="btn" data-act="closePopup">OK</button>';
  } else if (p.type === 'photo') {
    inner = '<h2 class="h2">写真・動画を見る前に</h2>' +
      '<p class="pre">' + nl2br(photoNote(p.no)) + '</p>' +
      extLink(p.url, 'わかりました、見る', 'btn photo-go') +
      '<button class="btn ghost" data-act="closePopup" data-autofocus>もどる</button>';
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
  } else if (p.type === 'share') {
    const c = findCard(p.id);
    const name = c ? esc(c.name) : '';
    if (p.key) {
      const url = location.origin + location.pathname + '#p=' + p.key;
      inner = '<h2 class="h2">' + name + ' さんのスマホで読み取ってください</h2>' +
        '<div class="qr">' + qrSvg(url) + '</div>' +
        '<p class="center-t"><b>今日の23:59まで</b>使えます</p>' +
        '<ul class="notes"><li>' + name + ' さんのスマホのカメラで読むと、このカードが開きます（ログインはいりません）</li>' +
        '<li>開けるのはこのカード1枚だけです。写真やこれまでの記録は見えません</li>' +
        '<li>こたえやスタンプは、このスマホのカードにも反映されます</li></ul>' +
        '<button class="btn ghost" data-act="stopShare">QRを止める</button>' +
        '<button class="btn" data-act="closePopup">とじる</button>';
    } else if (c && c.shareUntil) {
      inner = '<h2 class="h2">' + name + ' さんのスマホで使用中です</h2>' +
        '<p>今日の23:59まで使えるQRが出ています。もう一度QRを表示するときは「QRを出し直す」を押してください（前のQRは使えなくなります）</p>' +
        '<p id="pmsg" class="pmsg" role="alert"></p>' +
        '<button class="btn" data-act="doShare">QRを出し直す</button>' +
        '<button class="btn ghost" data-act="stopShare">QRを止める</button>' +
        '<button class="btn ghost" data-act="closePopup">とじる</button>';
    } else {
      inner = '<h2 class="h2">' + name + ' さんのスマホでも使う</h2>' +
        '<p>QRを出すと、' + name + ' さんが自分のスマホでこのカードを開けます。別々に行動していても、それぞれのスマホでミッションを進められます</p>' +
        '<ul class="notes"><li>ログインやメールアドレスの登録はいりません</li>' +
        '<li>開けるのはこのカード1枚だけです。写真やこれまでの記録は見えません</li>' +
        '<li>QRは今日の23:59まで使えます。いつでも止められます</li></ul>' +
        '<p id="pmsg" class="pmsg" role="alert"></p>' +
        '<button class="btn" data-act="doShare">QRを出す</button>' +
        '<button class="btn ghost" data-act="closePopup">とじる</button>';
    }
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
  // 11/4：返事を待つあいだに表紙をひらく（待ち時間を感じにくくする）
  const opening = openCover();
  let j = null;
  try { j = await api('login', [token]); } catch (_) { j = null; }
  S.busy = false;
  if (j && typeof j.sid === 'string' && j.data) {
    S.sid = j.sid;
    store.set('zp_sid', j.sid);
    setData(j.data);
    await opening;
    goHome(true);
    return;
  }
  closeCover();
  if (j && j.error === 'denied') {
    S.deniedEmail = typeof j.email === 'string' ? j.email : '';
    go('denied');
    return;
  }
  // denied 以外は、必ず nonce を取り直してボタンを作り直す
  prepareLogin(!j ? MSG.net : j.error === 'retry' ? MSG.retry : msgOf(j.error));
}
/** ログインできなかったら、表紙を閉じる */
function closeCover() {
  const book = document.querySelector('.pp-book');
  if (!book) return;
  book.classList.remove('opening');
  const cover = book.querySelector('.pp-cover');
  if (cover && cover.getAnimations) cover.getAnimations().forEach(a => a.cancel());
}
/** ログインできたら、パスポートの表紙をひらく（動きを減らす設定のときは、すぐ進む） */
function openCover() {
  const book = document.querySelector('.pp-book');
  const cover = book && book.querySelector('.pp-cover');
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { /* なし */ }
  if (!cover || reduce || typeof cover.animate !== 'function') return Promise.resolve();
  book.classList.add('opening');
  const anim = cover.animate(
    [{ transform: 'perspective(1000px) rotateY(0deg)' }, { transform: 'perspective(1000px) rotateY(-80deg)', opacity: 1, offset: .75 }, { transform: 'perspective(1000px) rotateY(-100deg)', opacity: 0 }],
    { duration: 800, easing: 'cubic-bezier(.55,0,.3,1)', fill: 'forwards' });
  return anim.finished.then(() => new Promise(r => setTimeout(r, 450))).catch(() => {});
}
function toLogin() {
  S.sid = '';
  S.data = null;
  store.set('zp_sid', '');
  store.set('zp_cur', '');
  S.cur = '';
  AQ.forEach(q => clearTimeout(q.timer));
  AQ.clear();
  PAST.clear();
  S.past = null;
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
/* field：'a' はこたえ、'w' は聞いた人 */
function onAnswerInput(el, field) {
  const f = field === 'w' ? 'w' : 'a';
  const id = el.dataset.card;
  const idx = Number(el.dataset.idx);
  const value = el.value;
  const c = findCard(id);
  if (c && f === 'a') c.answers[idx - 1] = value;
  if (c && f === 'w') { if (!Array.isArray(c.whos)) c.whos = ['', '', '']; c.whos[idx - 1] = value; }
  const key = id + ':' + (f === 'w' ? 'w' : '') + idx;
  const q = AQ.get(key) || { timer: 0, sending: false, dirty: false, value: '' };
  q.value = value;
  q.dirty = true;
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flushAnswer(id, idx, f), 1500);
  AQ.set(key, q);
}
/** スタンプの結果ごとの説明 */
function statusMsg(o) {
  if (o.status === 'already') return o.kid ? 'もう クリアしているよ' : 'もうクリア済みです';
  if (o.status === 'samestaff') return o.kid ? 'この ひとの シールは もう もらっているよ' : 'この人のシールはもうもらっています';
  if (o.status === 'noanswer') return o.kid ? 'こたえを かいてから もういちど いれてね' : 'こたえを書いてから、もう一度合言葉を入れてね';
  return kt('3つクリアしてから、{社|しゃ}{長|ちょう}の{認|にん}{定|てい}をもらってね', o.kid);
}
/** 送信待ちのこたえ・聞いた人を、すぐに送り切る（合言葉の前に呼ぶ） */
async function flushPending() {
  for (let n = 0; n < 8; n++) {
    const pend = Array.from(AQ.entries()).filter(([, q]) => q.dirty || q.sending);
    if (!pend.length) return;
    await Promise.all(pend.map(([key, q]) => {
      clearTimeout(q.timer);
      if (q.sending) return new Promise(r => setTimeout(r, 150));
      const i = key.lastIndexOf(':');
      const rest = key.slice(i + 1);
      const w = rest.charAt(0) === 'w';
      return flushAnswer(key.slice(0, i), Number(w ? rest.slice(1) : rest), w ? 'w' : 'a');
    }));
  }
}
async function flushAnswer(id, idx, field) {
  const f = field === 'w' ? 'w' : 'a';
  const key = id + ':' + (f === 'w' ? 'w' : '') + idx;
  const q = AQ.get(key);
  if (!q || q.sending || !q.dirty) return;
  q.sending = true;
  const v = q.value;
  let ok = false;
  try {
    const j = f === 'w'
      ? (S.pkey ? await api('pWho', [S.pkey, idx, v]) : await api('saveWho', [id, idx, v]))
      : (S.pkey ? await api('pAnswer', [S.pkey, idx, v]) : await api('saveAnswer', [id, idx, v]));
    if (j && j.ok) ok = true;
    else if (j && j.error) toast(msgOf(j.error));
  } catch (e) {
    if (e && e.message === 'expired') return;
    toast(MSG.net);
  } finally {
    q.sending = false;
  }
  if (q.value !== v) { flushAnswer(id, idx, f); return; } // 送信中に入力が続いた → 最新の値を1回だけ送る
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
  openRound(el) { const no = Number(el.dataset.no); if (isFinite(no) && no > 0) { S.roundNo = no; S.roundFrom = el.dataset.from === 'home' ? 'home' : 'record'; go('round'); } },
  roundBack() { go(S.roundNo ? 'round' : 'record'); },
  openCard() {
    if (!(S.data && S.data.event && S.data.event.cards)) { go('home'); return; }
    if (!S.pkey && !S.data.event.attended) { go('home'); toast(MSG.needcheckin); return; }
    if (S.screen === 'home') { const s = selfCard(); if (s) setCur(s.id); }
    go('card');
  },
  pick(el) { setCur(el.dataset.id); render(); },
  pickPast(el) { if (S.past) { S.past.cur = el.dataset.id; render(); } },
  pastCert() { go('pastCert'); },
  pastCardBack() { go('pastCard'); },
  async openPast(el) {
    const no = Number(el.dataset.no);
    if (!Number.isInteger(no)) return;
    const show = data => {
      const first = (data.cards || [])[0];
      S.past = { no: no, data: data, cur: first ? first.id : '' };
      go('pastCard');
    };
    if (PAST.has(no)) { show(PAST.get(no)); return; }
    await withBusy(async () => {
      const j = await api('past', [no]);
      if (!j || j.error) { toast(msgOf(j && j.error)); return; }
      PAST.set(no, j);
      show(j);
    });
  },
  cert() {
    const c = curCard();
    if (!c || clearCount(c) < 3) { go('card'); return; }
    go('cert');
  },
  addCard() { openPopup({ type: 'addCard' }); },
  askDelete() { const c = curCard(); if (c && c.kind !== 'self') openPopup({ type: 'delete', id: c.id }); },
  openClear(el) { const n = Number(el && el.dataset.idx); openPopup({ type: 'clear', idx: n >= 1 && n <= 3 ? n : 0 }); },
  openShare() { const c = curCard(); if (c && c.kind === 'adult') openPopup({ type: 'share', id: c.id }); },
  async doShare() {
    const id = S.popup && S.popup.id;
    if (!id) return;
    await withBusy(async () => {
      const j = await api('shareCard', [id]);
      if (j && j.error) { popupMsg(msgOf(j.error)); return; }
      setData(j.data);
      openPopup({ type: 'share', id: id, key: typeof j.key === 'string' && /^[0-9a-f]{64}$/.test(j.key) ? j.key : '' });
    });
  },
  async stopShare() {
    const id = S.popup && S.popup.id;
    if (!id) return;
    await withBusy(async () => {
      const j = await api('stopShare', [id]);
      if (j && j.error) { popupMsg(msgOf(j.error)); return; }
      setData(j.data);
      closePopup();
      toast('QRを止めました');
    });
  },
  openCheckin() { openPopup({ type: 'checkin' }); },
  openPhoto(el) { const u = safeUrl(el.dataset.url); if (u) openPopup({ type: 'photo', url: u, no: Number(el.dataset.no) || 0 }); },
  async doCheckin() {
    const el = document.getElementById('cpass');
    const pass = el ? el.value : '';
    if (!pass.trim() || Array.from(pass).length > 50) { popupMsg('合言葉を入力してね'); return; }
    const undo = busyLabel('doCheckin', 'たしかめています…');
    await withBusy(async () => {
      const j = await api('checkin', [pass]);
      if (j && j.error) { undo(); popupMsg(msgOf(j.error)); return; }
      setData(j.data);
      // 参加の合言葉が通ったら、今回の回のページを開く（ミッションカードもそこから開ける）
      S.roundNo = S.data.event.no;
      S.roundFrom = 'home';
      S.screen = 'round';
      window.scrollTo(0, 0);
      openPopup({ type: 'checked', already: !!j.already });
    });
  },
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
    await flushPending(); // 書いたばかりのこたえを先に保存する（スタンプはこたえが必要）
    const passEl = document.getElementById('pass');
    const pass = passEl ? passEl.value : '';
    const n = Array.from(pass).length;
    if (!pass.trim() || n > 50) { popupMsg('合言葉を入力してね'); return; }
    let ids;
    const boxes = document.querySelectorAll('input[name=cc]');
    if (boxes.length) ids = Array.from(boxes).filter(b => b.checked).map(b => b.value);
    else ids = curCard() ? [curCard().id] : [];
    if (!ids.length) { popupMsg('CLEARするカードを選んでね'); return; }
    // いま開いているカードを先頭に（押したミッションは、そのカードに使う。ほかのカードは自動で選ばれる）
    const curId = curCard() ? curCard().id : '';
    if (ids.includes(curId)) ids = [curId].concat(ids.filter(x => x !== curId));
    const idx = S.popup && S.popup.idx ? S.popup.idx : 0;
    const undo = busyLabel('doClear', 'たしかめています…');
    await withBusy(async () => {
      const j = S.pkey
        ? await api('pClear', idx ? [S.pkey, pass, idx] : [S.pkey, pass])
        : await api('clear', idx ? [ids, pass, idx] : [ids, pass]);
      if (j && j.error) { undo(); popupMsg(isKid(curCard()) && KID_MSG[j.error] ? KID_MSG[j.error] : msgOf(j.error)); return; }
      const nameOf = id => { const c = (j.data.cards || []).find(x => x.id === id); return c ? c.name : ''; };
      setData(j.data);
      const results = Array.isArray(j.results) ? j.results : [];
      // 表示はカードの並び順（本人が先）
      const order = cards().map(x => x.id);
      const ok = results.filter(r => r.status === 'ok').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const role = (results[0] && results[0].role) || 'M1';
      // こたえが空でスタンプが押せなかっただけのときは、合言葉の画面のまま案内する
      if (results.length && results.every(r => r.status === 'noanswer')) {
        const kid = results.length === 1 && isKid(findCard(results[0].id));
        undo();
        popupMsg(kid ? 'こたえを かいてから、もういちど あいことばを いれてね' : 'こたえを書いてから、もう一度合言葉を入れてね');
        return;
      }
      // 同じ人のシールがもうあるときも、合言葉の画面のまま案内する
      if (results.length && results.every(r => r.status === 'samestaff')) {
        undo();
        popupMsg(isKid(curCard()) ? staffName(role) + 'の シールは もう もらっているよ。ほかの じっこういいんに きいてね' : staffName(role) + 'のシールはもうもらっています。ほかの実行委員に聞いてね');
        return;
      }
      S.justCleared = {};
      ok.forEach(r => { S.justCleared[r.id + (r.role === 'cert' ? 'cert' : 'M' + r.idx)] = true; });
      S.popup = {
        type: 'result', role: role, okCount: ok.length, kid: isKid(curCard()),
        okIds: ok.map(r => r.id), okNames: ok.map(r => nameOf(r.id)),
        others: results.filter(r => r.status !== 'ok').map(r => ({ name: nameOf(r.id), status: r.status, kid: isKid(findCard(r.id)) })),
      };
      render();
    });
  },
};

function onClick(ev) {
  const go2 = ev.target.closest('a.photo-go');
  if (go2) { setTimeout(closePopup, 0); return; } // ドライブを開いたら確認を閉じる
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
  if (el && el.classList && el.classList.contains('ans')) onAnswerInput(el, 'a');
  else if (el && el.classList && el.classList.contains('who')) onAnswerInput(el, 'w');
}
function onKey(ev) {
  if (ev.key !== 'Enter' || ev.isComposing) return;
  const id = ev.target && ev.target.id;
  if (id === 'pass') { ev.preventDefault(); ACTIONS.doClear(); }
  else if (id === 'cpass') { ev.preventDefault(); ACTIONS.doCheckin(); }
  else if (id === 'famName') { ev.preventDefault(); }
}

/* ================================================================== */
/* 起動                                                                */
/* ================================================================== */
async function boot() {
  S.bootError = false;
  if (S.pkey) { bootPartner(); return; }
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
  goHome(true);
}
/** ホームへ。受付時間中でまだ参加していなければ、参加の合言葉の画面を自動で開く（タブで1回だけ。10/26） */
function goHome(ask) {
  go('home');
  const ev = S.data && S.data.event;
  if (ask && ev && ev.checkinOpen && !ev.attended && !store.get('zp_ask')) {
    store.set('zp_ask', '1');
    openPopup({ type: 'checkin' });
  }
}

/* パートナー用QR（#p=キー）で開いたとき：ログインなしで、そのカード1枚だけ */
async function bootPartner() {
  S.screen = 'boot';
  render();
  let j;
  try { j = await api('pGet', [S.pkey]); }
  catch (e) {
    if (e && e.message === 'expired') return;
    S.bootError = true; render(); return;
  }
  if (!j || j.error || !j.data) { S.bootError = true; render(); toast(msgOf(j && j.error)); return; }
  setData(j.data);
  go('card');
}
function endPartner() {
  S.pkey = '';
  store.set('zp_pk', '');
  S.data = null;
  AQ.forEach(q => clearTimeout(q.timer));
  AQ.clear();
  go('plink');
}
function readPartnerKey() {
  const m = /^#p=([0-9a-f]{64})$/.exec(location.hash || '');
  if (m) {
    store.set('zp_pk', m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* なし */ }
  }
  const k = store.get('zp_pk');
  S.pkey = /^[0-9a-f]{64}$/.test(k) ? k : '';
}

function init() {
  readPartnerKey();
  const app = document.getElementById('app');
  app.addEventListener('click', onClick);
  app.addEventListener('input', onInput);
  app.addEventListener('keydown', onKey);
  boot();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
