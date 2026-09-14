/* 填写演示：驱动的是 extension/ 里同一套引擎（由 tools/build_demo_bundle.py 打包）。
 *
 * 这里刻意不做任何"假装填写"的动画——扫描、分档、写入、高亮全部由真实引擎完成，
 * 所以演示结果与扩展在真实招聘页面上的行为一致，也不会随页面改版而失真。
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const dict = globalThis.RAF_DEMO_DICTIONARY;
  const RAF = globalThis.RAF;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const short = (s, n) => {
    const v = String(s ?? '');
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  };

  const form = $('demo-form');
  const form_ready = !!(dict && RAF && RAF.scanner && form);

  let plan = null;
  let paths = {};

  function notice(text, isError) {
    const el = $('notice');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  /* 与本机版 flatten() 同构：把资料摊平成 "路径 -> 值"，引擎只认这个结构。 */
  function flatten(profile) {
    const out = {};
    const repeated = dict.repeatedSections || [];
    Object.keys(dict.fields).forEach((section) => {
      const keys = Object.keys(dict.fields[section].fields);
      if (repeated.includes(section)) {
        (profile[section] || []).forEach((row, i) => {
          keys.forEach((key) => {
            const value = row[key];
            if (typeof value === 'boolean' || value === '' || value === null || value === undefined) return;
            out[section + '.' + i + '.' + key] = String(value);
          });
        });
        return;
      }
      const row = section === 'other' ? profile : (profile[section] || {});
      keys.forEach((key) => {
        const value = row[key];
        if (typeof value === 'boolean' || value === '' || value === null || value === undefined) return;
        out[(section === 'other' ? '' : section + '.') + key] = String(value);
      });
    });
    return out;
  }

  function bandLabel(band) {
    if (band === 'review') return '<span class="tag">待确认</span>';
    if (band === 'skipped') return '<span class="tag">已跳过</span>';
    return '<span class="tag blue">自动</span>';
  }

  function renderPlan() {
    const body = $('demo-plan');
    if (!body) return;
    const rows = plan.matched.map((entry) => (
      `<tr>
        <td><input type="checkbox" class="demo-pick" data-key="${esc(entry.key)}" checked></td>
        <td>${esc(entry.label)}</td>
        <td><small>${esc(entry.path)}</small></td>
        <td>${esc(short(paths[entry.path], 22))}</td>
        <td>${Math.round((entry.confidence || 0) * 100)}%</td>
        <td>${bandLabel(entry.band)}</td>
      </tr>`
    ));
    plan.manual.forEach((entry) => {
      rows.push(
        `<tr>
          <td><input type="checkbox" disabled></td>
          <td>${esc(entry.label || '(未命名字段)')}</td>
          <td><small>—</small></td>
          <td class="hint">不填写</td>
          <td>—</td>
          <td><span class="tag">需人工</span></td>
        </tr>`
      );
    });
    body.innerHTML = rows.join('');
    $('demo-plan-wrap').hidden = plan.matched.length === 0 && plan.manual.length === 0;
    $('demo-empty').hidden = !$('demo-plan-wrap').hidden;
  }

  function scan() {
    const profile = window.RAF_PROFILE || {};
    paths = flatten(profile);
    if (!Object.keys(paths).length) {
      notice('资料还是空的。请先到「我的资料」填写并保存，或点「载入示例」。', true);
      return;
    }
    const scanned = RAF.scanner.scan(form, dict.fields);
    plan = RAF.matcher.plan(dict, paths, scanned.fields, {url: location.href, title: '模拟招聘表单'});
    const auto = plan.matched.filter((e) => e.band !== 'review').length;
    const review = plan.matched.length - auto;
    renderPlan();
    const summary = '识别 ' + plan.detected + ' 个字段：可直接填写 ' + auto
      + ' 个、建议确认 ' + review + ' 个、需人工 ' + plan.manual.length + ' 个。'
      + (plan.manual.length ? '需人工的字段不会写入（敏感信息、条款勾选或未能识别）。' : '勾选后即可填写。');
    $('demo-summary').textContent = summary;
    notice(summary);
  }

  async function fill() {
    if (!plan) {
      notice('请先点「扫描这张表单」。', true);
      return;
    }
    const picked = new Set(Array.from(document.querySelectorAll('.demo-pick:checked'))
      .map((el) => el.dataset.key));
    const entries = plan.matched.filter((entry) => picked.has(entry.key));
    if (!entries.length) {
      notice('请至少勾选一个字段。', true);
      return;
    }

    RAF.highlight.clear();
    const outcome = await RAF.engine.fillPlan(dict, entries, paths, {
      overwrite: $('demo-overwrite').checked,
      gap: 30,
    });

    let filled = 0;
    let manual = 0;
    outcome.results.forEach((row) => {
      const el = row.elementId ? RAF.scanner.resolve(row.elementId) : null;
      if (row.status === 'filled') {
        filled += 1;
        if (el) RAF.highlight.mark(el, row.band === 'review' ? 'review' : 'filled');
      } else if (row.status === 'manual') {
        manual += 1;
        if (el) RAF.highlight.mark(el, 'manual');
      }
    });
    // 被规则挡下来的字段（敏感信息、条款勾选、未知控件）不是"填失败了"，
    // 而是刻意留给人处理——同样要在页面上标出来，否则用户不知道这里还有事没做。
    plan.manual.forEach((entry) => {
      const el = entry.elementId ? RAF.scanner.resolve(entry.elementId) : null;
      if (el && RAF.highlight.mark(el, 'manual')) manual += 1;
    });
    notice('已写入 ' + filled + ' 项，待人工 ' + manual + ' 项。'
      + '绿色=已填写，黄色=待确认，红色=需人工；提交按钮始终由你本人点击。');
  }

  /* 重复经历：扩展只点名称以「添加 / 新增」开头的按钮，新行也不会沿用上一行的数据。 */
  function addExperience() {
    const button = $('d-add');
    if (!RAF.guard.isNavAllowed(dict, button)) {
      notice('这个按钮不符合「添加 / 新增」规则，扩展不会点击它。', true);
      return;
    }
    const section = form.querySelectorAll('.demo-section')[1];
    if (!section) return;
    const row = document.createElement('div');
    row.className = 'demo-grid';
    row.innerHTML =
      '<div><label for="d2-school">学校</label><input id="d2-school" name="school"></div>' +
      '<div><label for="d2-major">专业</label><input id="d2-major" name="major"></div>';
    section.appendChild(row);
    notice('已新增一行教育经历。资料里若没有第 2 条经历，它就不会被填写——请重新扫描。');
  }

  if (form_ready) {
    $('demo-scan').addEventListener('click', scan);
    $('demo-fill').addEventListener('click', fill);
    $('demo-clear').addEventListener('click', () => {
      RAF.highlight.clear();
      notice('已清空高亮，已填写的内容保留在表单里。');
    });
    $('d-add').addEventListener('click', addExperience);

    // 演示边界：提交由人完成，页面只在这里说明一次。
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const outcome = $('d-outcome');
      outcome.hidden = false;
      outcome.textContent = '这是演示页面，不会真的投递。'
        + '真实场景中「提交 / 投递 / 申请」按钮一律由你本人点击，扩展不会替你按下。';
    });
  } else {
    notice('演示引擎未加载，请确认 engine.js 与本页在同一目录。', true);
  }
})();
