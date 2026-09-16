/* DSH 可见光标图层 + 点击命中判定（注入到页面 DOM，纯视觉，不拦截任何事件）
 *
 * 背景：browser_click 走 CDP Input.dispatchMouseEvent，不会移动系统指针，
 * 用户在浏览器窗口里看不到鼠标，也看不到"这一次点击到底有没有生效"。
 *
 * 用法（Agent 侧的顺序。注意：这些是在 browser_evaluate 里执行的**表达式**，
 * 工具只 await 表达式返回的 Promise、不会把代码包进 async 函数 —— 写裸 `await` 会 SyntaxError）：
 *   __dshCursor.clickTo('#submit')            // 1. 光标滑过去 + 波纹；内部会 arm 预期目标并接管这次点击
 *   browser_click(ref)                        // 2. 真实点击，拿到 { clicked:{x,y}, hitVerified, hitInstead }
 *   __dshCursor.settle({ x, y, hitVerified }) // 3. 判定 + 上色（clickTo 已自动接管；这步只在要结构化结果时调）
 *
 * settle() 会把光标重新锚定到**工具报告的真实点击坐标**（元素可能被 scrollIntoView 挪过），
 * 所以屏幕上的位置始终等于实际点击位置。
 *
 * 判定分级（status）：
 *   ok           命中
 *   covered      点击坐标上压着别的元素（工具预检失败，或事件被上层元素吃掉）
 *   no-event     点击坐标处没有任何 click 事件到达页面
 *   wrong-point  事件坐标与预期不符
 *   prevented    页面处理器 preventDefault（默认行为被拦）
 *   stopped      事件在冒泡途中被 stopPropagation
 *   not-armed    没有先 arm 预期目标
 *   附注 notes：target-moved（点击前后元素位移）、target-removed（点击后元素被移除，常见于框架重渲染）
 *
 * 跨导航持久化：CDP Page.addScriptToEvaluateOnNewDocument(source=<本文件内容>)。
 * 注意 document-start 时 document.documentElement 可能还是 null，所以这里等根节点出现。
 */
(() => {
  function install() {
    if (window.__dshCursor) return 'exists';

    const st = document.createElement('style');
    st.id = '__dsh_style';
    st.textContent = `
#__dsh_cursor{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;
  transform:translate3d(-300px,-300px,0);transition:transform .5s cubic-bezier(.22,.61,.36,1)}
#__dsh_cursor.instant{transition:none}
#__dsh_cursor svg{position:absolute;left:0;top:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.55))}
#__dsh_cursor svg path{fill:#fff;stroke:#111;transition:fill .15s}
/* 青色而非红色：红波纹落在红色按钮上完全看不见（实测） */
#__dsh_halo{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;
  border:2px solid rgba(46,230,255,.95);background:rgba(46,230,255,.18);animation:__dsh_halo 1.5s ease-out infinite}
@keyframes __dsh_halo{0%{transform:scale(.4);opacity:.95}70%{transform:scale(1.4);opacity:0}100%{transform:scale(1.4);opacity:0}}
#__dsh_label{position:absolute;left:15px;top:19px;font:600 11px/1.65 -apple-system,system-ui,sans-serif;
  color:#fff;background:#ff2d55;padding:0 7px;border-radius:9px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4)}
#__dsh_ripple{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none}
#__dsh_ripple i{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;display:block;
  border:4px solid #2ee6ff;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 18px rgba(46,230,255,.9);opacity:0}
#__dsh_ripple i.go{animation:__dsh_pop 1.3s ease-out}
@keyframes __dsh_pop{0%{opacity:1;transform:scale(.2)}100%{opacity:0;transform:scale(1.5)}}

/* ---- 判定结果视觉 ---- */
#__dsh_cursor.ok svg path{fill:#28c76f;stroke:#05301b}
#__dsh_cursor.warn svg path{fill:#ff3b30;stroke:#3d0000}
#__dsh_cursor.warn #__dsh_halo{border-color:rgba(255,59,48,.95);background:rgba(255,59,48,.2);animation-duration:.7s}
#__dsh_cursor.ok #__dsh_halo{border-color:rgba(40,199,111,.95);background:rgba(40,199,111,.2)}
#__dsh_cursor.warn #__dsh_label{background:#ff3b30}
#__dsh_cursor.ok #__dsh_label{background:#1a9c56}

#__dsh_verdict{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483645;pointer-events:none}
#__dsh_verdict.hidden{display:none}
#__dsh_ring{position:absolute;left:-30px;top:-30px;width:60px;height:60px;border-radius:50%;box-sizing:border-box;
  border:3px solid #ff3b30;box-shadow:0 0 16px rgba(255,59,48,.9),inset 0 0 16px rgba(255,59,48,.35)}
#__dsh_verdict.ok #__dsh_ring{border-color:#28c76f;box-shadow:0 0 16px rgba(40,199,111,.9);
  width:40px;height:40px;left:-20px;top:-20px;border-width:2px}
#__dsh_cross{position:absolute;left:-12px;top:-12px;width:24px;height:24px;display:none}
#__dsh_verdict.warn #__dsh_cross{display:block}
#__dsh_cross i{position:absolute;left:10px;top:0;width:4px;height:24px;background:#ff3b30;border-radius:2px;
  box-shadow:0 0 6px rgba(0,0,0,.6)}
#__dsh_cross i:first-child{transform:rotate(45deg)}
#__dsh_cross i:last-child{transform:rotate(-45deg)}
#__dsh_warnbox{position:fixed;display:none;border:2px dashed #ff3b30;background:rgba(255,59,48,.10);
  border-radius:6px;box-sizing:border-box}
#__dsh_warnbox.show{display:block}
#__dsh_warnbox b{position:absolute;left:-2px;top:-21px;font:600 11px/1.7 -apple-system,system-ui,sans-serif;
  color:#fff;background:#ff3b30;padding:0 7px;border-radius:9px 9px 9px 0;white-space:nowrap;
  box-shadow:0 1px 4px rgba(0,0,0,.4)}
#__dsh_toast{position:fixed;display:none;max-width:360px;font:600 12px/1.55 -apple-system,system-ui,sans-serif;
  color:#fff;background:rgba(176,22,12,.96);border:1px solid #ff6b5e;padding:7px 11px;border-radius:9px;
  box-shadow:0 6px 20px rgba(0,0,0,.5);white-space:pre-line}
#__dsh_toast.show{display:block}

/* 铁律：图层绝不能吃掉任何点击。少了这条，红色虚线框自己会变成"遮挡物"，
   工具预检立刻报 hitVerified:false —— 实测踩过。 */
#__dsh_cursor,#__dsh_ripple,#__dsh_verdict,#__dsh_warnbox,#__dsh_toast,
#__dsh_cursor *,#__dsh_ripple *,#__dsh_verdict *,#__dsh_warnbox *,#__dsh_toast *{
  pointer-events:none !important}`;
    document.documentElement.appendChild(st);

    const cur = document.createElement('div');
    cur.id = '__dsh_cursor';
    cur.innerHTML = '<div id="__dsh_halo"></div>' +
      '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 1.5 L2 21 L7 16.6 L10.5 24 L14 22.3 L10.6 15 L17 14.6 Z" ' +
      'stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div id="__dsh_label">DSH</div>';
    const label = cur.querySelector('#__dsh_label');

    const rip = document.createElement('div');
    rip.id = '__dsh_ripple';
    rip.innerHTML = '<i></i>';

    const verdict = document.createElement('div');
    verdict.id = '__dsh_verdict';
    verdict.className = 'hidden';
    verdict.innerHTML = '<div id="__dsh_ring"></div><div id="__dsh_cross"><i></i><i></i></div>';

    const warnbox = document.createElement('div');
    warnbox.id = '__dsh_warnbox';
    warnbox.innerHTML = '<b></b>';

    const toast = document.createElement('div');
    toast.id = '__dsh_toast';

    document.documentElement.append(cur, rip, verdict, warnbox, toast);

    // ---------- 事件记录（只读，不拦截） ----------
    const evts = [];
    const MAX_EVENTS = 300;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function desc(el) {
      if (!el) return '(null)';
      if (el.nodeType === 3) return 'text';
      if (el.nodeType !== 1) return String(el.nodeName || el);
      let s = String(el.tagName || '').toLowerCase();
      if (el.id) s += '#' + el.id;
      const cls = String(typeof el.className === 'string' ? el.className : el.getAttribute('class') || '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      return s;
    }

    function record(phase, e) {
      if (evts.length >= MAX_EVENTS) evts.shift();
      evts.push({ phase, type: e.type, x: e.clientX, y: e.clientY, t: Date.now(), el: e.target, ev: e });
    }
    window.addEventListener('mousedown', (e) => record('capture', e), true);
    window.addEventListener('mouseup', (e) => record('capture', e), true);
    window.addEventListener('click', (e) => record('capture', e), true);
    window.addEventListener('click', (e) => record('bubble', e), false);

    // ---------- 内部状态 ----------
    let armed = null;
    let verdictTimer = null;
    let auto = null;   // 自动判定：{ onEv, timer }

    function stopAuto() {
      if (!auto) return;
      window.removeEventListener('click', auto.onEv, true);
      clearTimeout(auto.timer);
      auto = null;
    }

    function clearVerdict() {
      clearTimeout(verdictTimer);
      cur.classList.remove('warn', 'ok');
      label.textContent = 'DSH';
      verdict.className = 'hidden';
      warnbox.className = '';
      toast.className = '';
    }

    function paintVerdict(status, text, x, y, culprit, message) {
      clearTimeout(verdictTimer);
      const good = status === 'ok';
      cur.classList.toggle('warn', !good);
      cur.classList.toggle('ok', good);
      label.textContent = text;

      verdict.classList.remove('hidden');
      verdict.classList.toggle('ok', good);
      verdict.classList.toggle('warn', !good);
      verdict.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';

      if (culprit && culprit.getBoundingClientRect) {
        const r = culprit.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          warnbox.style.left = r.left + 'px';
          warnbox.style.top = r.top + 'px';
          warnbox.style.width = r.width + 'px';
          warnbox.style.height = r.height + 'px';
          warnbox.querySelector('b').textContent = '真正吃到点击的是 ' + desc(culprit);
          warnbox.classList.add('show');
        }
      }

      if (message) {
        const tw = 360;
        const left = Math.max(8, Math.min(x + 26, (window.innerWidth || 1200) - tw - 8));
        const top = Math.max(8, Math.min(y + 34, (window.innerHeight || 800) - 70));
        toast.style.left = left + 'px';
        toast.style.top = top + 'px';
        toast.textContent = message;
        toast.classList.add('show');
      }

      // 判定结论一直留着，直到下一次操作（arm/clearWarn）—— 闪一下就没了等于没提示
    }

    // ---------- API ----------
    const api = {
      _p: { x: -300, y: -300 },
      get pos() { return api._p; },
      get armed() { return armed ? { selector: armed.selector, x: armed.x, y: armed.y, el: desc(armed.el) } : null; },

      move(x, y, dur = 500) {
        cur.classList.toggle('instant', !dur);
        void cur.offsetWidth;
        cur.style.transitionDuration = dur + 'ms';
        cur.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        api._p = { x: Math.round(x), y: Math.round(y) };
        return api._p;
      },

      center(el) {
        const n = typeof el === 'string' ? document.querySelector(el) : el;
        if (!n) throw new Error('cursor-overlay: 找不到元素 ' + el);
        const r = n.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), el: n };
      },

      /** 记录"我打算点谁"，并清空事件缓冲。clickTo 会自动调用。 */
      arm(el) {
        const c = api.center(el);
        armed = { selector: typeof el === 'string' ? el : desc(el), el: c.el, x: c.x, y: c.y,
                  rect: c.el.getBoundingClientRect(), t: Date.now() };
        evts.length = 0;
        clearVerdict();
        return { selector: armed.selector, x: armed.x, y: armed.y };
      },

      clearWarn() { clearVerdict(); },

      async moveTo(el, dur = 500) {
        const c = api.center(el);
        api.move(c.x, c.y, dur);
        await sleep(dur + 60);
        return { x: c.x, y: c.y };
      },

      async clickAt(x, y, dur = 450) {
        api.move(x, y, dur);
        await sleep(dur + 90);
        rip.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        const i = rip.firstChild;
        i.classList.remove('go');
        void i.offsetWidth;
        i.classList.add('go');
        return { x: Math.round(x), y: Math.round(y) };
      },

      /**
       * 滑到目标 + 波纹，并**接管接下来那一次点击**：事件一到就自动判定上色。
       * 超时（默认 5s）会先按 no-event 报红，但监听保留 —— 迟到的点击会重新判定并覆盖它。
       * 实测教训：Agent 的 evaluate→browser_click 往返可能超过 1.5s，超时太短会误报。
       * opts.autoSettle === false 关闭；opts.noEventAfter 自定义超时。
       */
      async clickTo(el, dur = 450, opts = {}) {
        api.arm(el);
        const c = api.center(el);
        const res = await api.clickAt(c.x, c.y, dur);
        if (opts.autoSettle !== false) {
          stopAuto();
          const onEv = (e) => {
            stopAuto();
            setTimeout(() => {
              try { api.settle({ x: Math.round(e.clientX), y: Math.round(e.clientY) }, true); } catch (_) {}
            }, 220);
          };
          window.addEventListener('click', onEv, true);
          const timer = setTimeout(() => { api.settle({}, true); }, opts.noEventAfter === undefined ? 5000 : opts.noEventAfter);
          auto = { onEv, timer };
        }
        return res;
      },

      /**
       * 点击后的判定 + 上色。
       * opts: { x, y, hitVerified, hitInstead, wait }
       *   x/y          工具 browser_click 返回的 clicked.x/y —— 用它把光标锚到真实落点
       *   hitVerified  工具的预检结果（false = 坐标上压着别的元素）
       *   hitInstead   工具报告的"实际命中的标签名"
       *   wait         等多久再判定（默认 260ms，给页面处理器留出反应时间）
       */
      async settle(opts = {}, internal = false) {
        if (!internal) stopAuto();
        const wait = opts.wait === undefined ? 260 : opts.wait;
        if (!armed) return { status: 'not-armed', ok: true };
        const target = armed;

        if (typeof opts.x === 'number' && typeof opts.y === 'number') {
          // 工具的真实落点才算数：元素可能被 scrollIntoView 挪过位置
          api.move(opts.x, opts.y, 0);
        }
        await sleep(wait);

        const x = api._p.x, y = api._p.y;
        const since = evts.filter((r) => r.t >= target.t - 40);
        const clicks = since.filter((r) => r.type === 'click' && r.phase === 'capture');
        const clickBubble = since.some((r) => r.type === 'click' && r.phase === 'bubble');
        const notes = [];
        let status = 'ok', reason = '', culprit = null;

        const moved = (() => {
          if (!target.el || !target.el.getBoundingClientRect) return 0;
          const r = target.el.getBoundingClientRect();
          return Math.round(Math.hypot((r.left + r.width / 2) - target.x, (r.top + r.height / 2) - target.y));
        })();
        if (moved > 4) notes.push('target-moved(+' + moved + 'px)');

        if (opts.hitVerified === false) {
          status = 'covered';
          culprit = document.elementFromPoint(x, y) || (clickedEl(clicks) || null);
          reason = '点击坐标上压着别的元素：' + desc(culprit) +
                   (opts.hitInstead && desc(culprit).indexOf(opts.hitInstead) !== 0 ? '（工具报告命中 ' + opts.hitInstead + '）' : '');
        } else if (clicks.length === 0) {
          status = 'no-event';
          culprit = document.elementFromPoint(x, y);
          reason = '点击坐标处没有任何 click 事件到达页面' + (culprit ? '：上层是 ' + desc(culprit) : '');
        } else {
          const c = clicks[0];
          const hitEl = c.el;
          const inside = hitEl && (hitEl === target.el || target.el.contains(hitEl));
          const dx = Math.abs(c.x - x), dy = Math.abs(c.y - y);
          if (dx > 3 || dy > 3) {
            status = 'wrong-point';
            reason = '事件落在 (' + c.x + ',' + c.y + ')，与光标位置 (' + x + ',' + y + ') 不符';
          } else if (!inside) {
            status = 'covered';
            culprit = hitEl;
            reason = '实际吃到点击的是 ' + desc(hitEl) + '，不是预期目标 ' + desc(target.el);
          } else if (clicks.some((r) => r.ev.defaultPrevented)) {
            status = 'prevented';
            reason = '页面处理器 preventDefault()：默认行为被拦下（事件到了 ' + desc(hitEl) + '，但没生效）';
          } else if (!clickBubble) {
            status = 'stopped';
            reason = '事件在冒泡途中被 stopPropagation()，外层/框架收不到这次点击';
          }
        }

        // 元凶如果是我自己的图层，说明 pointer-events:none 那条铁律被破坏了
        if (culprit && /^__dsh_/.test(culprit.id || '')) notes.push('overlay-self-intercept');

        if (status === 'ok' && target.el && !target.el.isConnected) notes.push('target-removed');

        if (status === 'ok') {
          paintVerdict('ok', '命中', x, y, null, null);
        } else {
          const titles = { covered: '被遮挡', 'no-event': '事件未到达', 'wrong-point': '落点不符',
                           prevented: '被拦截', stopped: '被拦截' };
          paintVerdict(status, titles[status] || '异常', x, y, culprit,
            '⚠ ' + (titles[status] || status) + '：' + reason + (notes.length ? '\n（' + notes.join('、') + '）' : ''));
        }

        return {
          status, ok: status === 'ok', reason, notes,
          expected: { selector: target.selector, x: target.x, y: target.y, tag: desc(target.el) },
          clickedAt: { x, y },
          eventSeen: clicks.length > 0,
          eventCoords: clicks.length ? { x: clicks[0].x, y: clicks[0].y } : null,
          eventTarget: clicks.length ? desc(clicks[0].el) : null,
          culprit: culprit ? desc(culprit) : null,
          topAtPoint: desc(document.elementFromPoint(x, y)),
        };

        function clickedEl(list) { return list.length ? list[0].el : null; }
      },

      hide() { cur.style.display = 'none'; rip.style.display = 'none'; },
      show() { cur.style.display = ''; rip.style.display = ''; }
    };

    window.__dshCursor = api;
    return 'installed';
  }

  // document-start 注入时根节点可能还没建好，等它出现
  if (document.documentElement) return install();
  const mo = new MutationObserver(() => {
    if (document.documentElement) { mo.disconnect(); install(); }
  });
  mo.observe(document, { childList: true, subtree: true });
  return 'waiting-for-root';
})();
