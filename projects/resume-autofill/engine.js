/* 由 tools/build_demo_bundle.py 从 extension/ 生成，请勿手工修改。
 * 这里跑的是扩展里同一套 DOM 扫描、置信度匹配与填写引擎。 */

/* ---- extension/utils/namespace.js ---- */

/* Shared namespace for the content-script bundle.
 *
 * Chrome injects every file listed in manifest.json `content_scripts[].js` into the
 * *same* isolated world, as classic scripts. They therefore share one global scope,
 * which is why this file must not be an ES module (module content scripts are not
 * supported) and why each file uses an IIFE plus `var` instead of top-level
 * `const`/`let` (redeclaring those across files is a hard SyntaxError).
 *
 * Everything lives on `globalThis.RAF` so the modules stay testable outside Chrome.
 */
var RAF = globalThis.RAF || (globalThis.RAF = {});

RAF.VERSION = '1.0.0';

/* ---- extension/utils/selectors.js ---- */

/* DOM reading helpers.
 *
 * Ported from `recruitment/static/scan.js` (the Playwright build) so both engines
 * describe a label the same way. Kept free of Chrome APIs so it can run under jsdom.
 */
(function (RAF) {
  'use strict';

  const SELECTORS = {
    // Framework-neutral form-row wrappers. Public class conventions only; no
    // site-proprietary selector is invented anywhere in this project.
    container: '.form-item,.ant-form-item,.el-form-item,.arco-form-item,.semi-form-field,.t-form__item,.ats-form-item,[class*="form-item"],[class*="formItem"],[class*="FormItem"]',
    label: 'label,[class*="label"],[class*="Label"]',
    heading: ':scope > legend, :scope > h2, :scope > h3, :scope > h4, :scope > [class*="section-title"], :scope > [class*="block-title"], :scope > [class*="sectionTitle"]',
    controls: 'input,textarea,select,[contenteditable="true"],[role="combobox"]',
  };

  const S = { SELECTORS };

  S.tidy = (value) => String(value == null ? '' : value).replace(/[＊*：:]/g, '').replace(/\s+/g, ' ').trim();

  S.text = (el, limit = 180) => (el ? S.tidy(el.innerText || el.textContent || '').slice(0, limit) : '');

  S.labelText = (el) => {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('input,select,textarea,[contenteditable],[role="listbox"]').forEach((node) => node.remove());
    return S.tidy(copy.textContent).slice(0, 180);
  };

  // "请输入姓名" / "Please enter your name" -> "姓名" / "your name", so a prompt
  // sentence can still hit the dictionary as an exact alias.
  const PROMPT = /^(?:请|请输入|请填写|请选择|请提供|please\s+(?:enter|input|select|provide|fill|type)|enter|input|select|type|e\.g\.?|eg|example|your|您的|你的|您)[\s：:、]*/i;
  S.stripPrompt = (value) => {
    let result = S.tidy(value);
    for (let i = 0; i < 3 && PROMPT.test(result); i += 1) result = result.replace(PROMPT, '').trim();
    return result;
  };

  // Mirrors matching.normalize() on the Python side: drop separators, lowercase.
  S.normalize = (value) => S.tidy(value).replace(/[\s＊*：:()（）_\-]+/g, '').toLowerCase();

  // jsdom has no layout engine (every rect is 0x0), so geometry may only be trusted
  // once we know the document actually performs layout. Probed once per document.
  const layoutCache = new WeakMap();
  function hasLayout(doc) {
    if (layoutCache.has(doc)) return layoutCache.get(doc);
    let value = true;
    try {
      const probe = doc.createElement('div');
      probe.style.cssText = 'position:absolute;top:-9999px;width:10px;height:10px;';
      (doc.body || doc.documentElement).appendChild(probe);
      value = probe.getBoundingClientRect().width > 0;
      probe.remove();
    } catch (error) {
      value = true;
    }
    layoutCache.set(doc, value);
    return value;
  }

  S.hasLayout = hasLayout;

  S.visible = (el) => {
    if (!el) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.disabled || el.closest('[inert]')) return false;
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    const style = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    if (!doc || !hasLayout(doc)) return true;
    return el.getClientRects().length > 0;
  };

  S.container = (el) => (el.closest ? el.closest(SELECTORS.container) : null);

  S.heading = (node) => (node && node.querySelector ? node.querySelector(SELECTORS.heading) : null);

  S.parseSpecs = (specs) => {
    const map = specs && specs.fields ? specs.fields : specs || {};
    const scalar = (specs && specs.scalarSections) || ['personal_information', 'other'];
    const repeated = Object.keys(map).filter((key) => !scalar.includes(key));
    return { map, scalar, repeated };
  };

  // Detects which repeated section a control belongs to by walking up the tree and
  // testing each ancestor heading against the section titles/aliases in the schema.
  S.sectionOf = (el, specs) => {
    const { map, repeated } = S.parseSpecs(specs);
    const table = repeated.map((key) => ({
      key,
      names: [key, map[key] && map[key].title].concat((map[key] && map[key].aliases) || []).filter(Boolean),
    }));
    const kind = (raw) => {
      const haystack = String(raw || '').toLowerCase();
      if (!haystack) return '';
      const hit = table.find((row) => row.names.some((name) => haystack.includes(String(name).toLowerCase())));
      return hit ? hit.key : '';
    };
    const doc = el.ownerDocument;
    for (let parent = el.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const found = kind(
        parent.getAttribute('data-section') || S.text(S.heading(parent)) || parent.getAttribute('data-raf-section'),
      );
      if (found) return found;
    }
    return '';
  };

  S.options = (el) => {
    if (el.tagName !== 'SELECT') return [];
    return Array.from(el.options || []).map((option) => ({
      label: S.tidy(option.label || option.textContent),
      value: String(option.value),
      disabled: !!option.disabled,
    }));
  };

  S.currentValue = (el) => {
    if (el.tagName === 'SELECT') return String(el.value == null ? '' : el.value);
    if (el.type === 'file') return Array.from(el.files || []).map((file) => file.name).join(', ');
    if (el.type === 'radio' || el.type === 'checkbox') return el.checked ? 'true' : '';
    if (el.isContentEditable) return S.tidy(el.innerText);
    return String(el.value == null ? el.innerText || '' : el.value);
  };

  S.uniqueId = (() => {
    let sequence = 0;
    return (prefix) => {
      sequence += 1;
      // crypto.randomUUID() needs a secure context; plain http job pages do not have one.
      return `${prefix || 'raf'}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
    };
  })();

  RAF.selectors = S;
})(globalThis.RAF);

/* ---- extension/utils/events.js ---- */

/* Value writing + event plumbing.
 *
 * A plain `input.value = x` is invisible to React (it caches the last value on the
 * node) and to Vue/Angular bindings, and it never fires the events a form library
 * listens for. Everything funnels through the prototype setter plus a full
 * input/change/blur sequence.
 */
(function (RAF) {
  'use strict';

  const E = {};

  const view = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;

  E.setValue = (el, value) => {
    const win = view(el);
    const proto = el.tagName === 'TEXTAREA'
      ? win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype
      : el.tagName === 'INPUT' && win.HTMLInputElement && win.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  };

  E.setChecked = (el, checked) => {
    const win = view(el);
    const proto = win.HTMLInputElement && win.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'checked');
    if (descriptor && descriptor.set) descriptor.set.call(el, checked);
    else el.checked = checked;
  };

  E.fire = (el, type) => {
    const win = view(el);
    const isClick = type === 'click';
    const Ctor = (isClick ? win.MouseEvent : win.Event) || win.Event;
    const options = isClick
      ? { bubbles: true, cancelable: true, composed: true, view: win }
      : { bubbles: true, composed: true };
    let event;
    try {
      event = new Ctor(type, options);
    } catch (error) {
      event = new win.Event(type, { bubbles: true });
    }
    el.dispatchEvent(event);
  };

  E.commit = (el, value) => {
    E.setValue(el, value);
    if (el.isContentEditable) {
      el.textContent = value;
      E.fire(el, 'input');
    }
    E.fire(el, 'input');
    E.fire(el, 'change');
    E.fire(el, 'blur');
  };

  // React implements onChange for checkboxes/radios with a *click* listener, but a
  // synthetic click re-toggles the node. So: use the real click when it reaches the
  // wanted state, and only fall back to the setter when a controlled component
  // reverts it.
  E.commitChecked = (el, checked) => {
    if (el.checked !== checked) el.click();
    if (el.checked !== checked) {
      E.setChecked(el, checked);
      E.fire(el, 'input');
      E.fire(el, 'change');
    } else {
      E.fire(el, 'input');
      E.fire(el, 'change');
    }
    E.fire(el, 'blur');
  };

  E.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Ant/Element/Arco render their dropdown after a tick, so option lookup has to wait.
  E.waitFor = (predicate, options) => {
    const settings = Object.assign({ timeout: 1200, interval: 50 }, options || {});
    const deadline = Date.now() + settings.timeout;
    return new Promise((resolve) => {
      const tick = () => {
        let found = null;
        try {
          found = predicate();
        } catch (error) {
          found = null;
        }
        if (found) return resolve(found);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, settings.interval);
      };
      tick();
    });
  };

  E.debounce = (fn, ms) => {
    let timer = null;
    return function debounced() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    };
  };

  // Renders the text a human would see, used to match dropdown options.
  E.optionText = (node) => (RAF.selectors ? RAF.selectors.tidy(node.innerText || node.textContent || '') : '');

  RAF.events = E;
})(globalThis.RAF);

/* ---- extension/matcher/fieldMatcher.js ---- */

/* Field matching engine.
 *
 * Turns an anonymous form control into a Profile path such as
 * `personal_information.phone` or `education.1.school`, together with a confidence
 * score (PRD §10-§12).
 *
 * The hard constraints are ports of `recruitment/matching.py` and are the reason
 * this file can be trusted with sensitive data:
 *   - a control needs a readable label and must not be a password/sensitive field;
 *   - a repeated-section value may only land in the row it was scanned from;
 *   - a control that sits inside a section can never be filled from the flat
 *     personal profile (otherwise a name would be pasted into "company name").
 *
 * Matching itself is layered (PRD §28): site adapter > dictionary > fuzzy rules >
 * AI fallback > human.
 */
(function (RAF) {
  'use strict';

  const S = RAF.selectors;
  const M = {};

  // How much a match found in each text source is trusted.
  const SOURCE_WEIGHT = { label: 1, placeholder: 0.95, attribute: 0.9, nearby: 0.75 };

  function bigrams(text) {
    const grams = new Set();
    if (text.length < 2) {
      if (text) grams.add(text);
      return grams;
    }
    for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
    return grams;
  }

  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const left = bigrams(a);
    const right = bigrams(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    left.forEach((gram) => {
      if (right.has(gram)) shared += 1;
    });
    return (2 * shared) / (left.size + right.size);
  }

  // Exact > containment (scaled by length) > character overlap.
  // "候选人姓名" vs "姓名" scores 0.71 and lands in the human-review band rather
  // than being filled blindly.
  M.similarity = (candidate, alias) => {
    const a = S.normalize(candidate);
    const b = S.normalize(alias);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      return 0.55 + 0.4 * ratio;
    }
    return Math.max(0, dice(a, b) - 0.05);
  };

  // Every string a human would read as this field's name.
  M.sources = (field) => {
    const out = [];
    if (field.label) out.push(['label', S.stripPrompt(field.label)]);
    if (field.placeholder) out.push(['placeholder', S.stripPrompt(field.placeholder)]);
    ['name', 'id', 'ariaLabel', 'dataLabel'].forEach((key) => {
      if (field[key]) out.push(['attribute', String(field[key])]);
    });
    if (field.nearbyText) out.push(['nearby', field.nearbyText]);
    return out.filter((pair) => pair[1]);
  };

  M.score = (field, alias) => {
    let best = { score: 0, source: '' };
    M.sources(field).forEach(([source, text]) => {
      const raw = M.similarity(text, alias);
      if (!raw) return;
      // `name`/`id`/`data-*` are developer slugs, not user-facing text. Only an exact
      // normalized hit counts: "companyName" merely *containing* "name" must not be
      // read as "name", otherwise a company field would receive the candidate's name.
      if (source === 'attribute' && raw < 1) return;
      const score = raw === 1 ? (source === 'nearby' ? 0.9 : 1) : Math.min(0.99, raw * SOURCE_WEIGHT[source]);
      if (score > best.score) best = { score, source, matchedText: text };
    });
    return best;
  };

  const regexCache = new Map();
  function rule(regex, flags) {
    const key = flags + ':' + regex;
    if (!regexCache.has(key)) regexCache.set(key, new RegExp(regex, flags));
    return regexCache.get(key);
  }

  M.sensitive = (text, dictionary) => rule(dictionary.rules.sensitive, 'i').test(String(text || ''));

  // Port of matching.permitted_field().
  M.permitted = (dictionary, field) => {
    if (!field || !field.label) return false;
    if (M.sensitive(field.label, dictionary)) return false;
    return !dictionary.rules.blockedInputTypes.includes(field.type);
  };

  // Port of matching.path_allowed().
  M.pathAllowed = (dictionary, field, path) => {
    const parts = String(path).split('.');
    if (dictionary.repeatedSections.includes(parts[0])) {
      return parts.length === 3 && field.section === parts[0] && String(parts[1]) === String(field.row_index);
    }
    return !field.section;
  };

  // Port of matching.match() prefix building.
  M.pathOf = (dictionary, section, key, field) => {
    if (dictionary.scalarSections.includes(section)) {
      return section === 'personal_information' ? 'personal_information.' + key : key;
    }
    if (field.section !== section) return '';
    if (!Number.isInteger(field.row_index) || field.row_index < 0) return '';
    return section + '.' + field.row_index + '.' + key;
  };

  M.key = (field) => [
    field.section || '',
    field.row_index,
    field.tag,
    field.type,
    S.normalize(field.label),
  ].join('|');

  M.matchField = (dictionary, paths, field) => {
    if (!M.permitted(dictionary, field)) {
      return {
        path: '',
        band: 'skipped',
        confidence: 0,
        reason: field && field.label ? '该字段属于敏感/不支持类型，需人工填写' : '未取到可读标签，需人工填写',
      };
    }
    // A control inside a known section is restricted to that section; a flat control
    // may only be filled from the two scalar sections.
    const sections = field.section ? [field.section] : dictionary.scalarSections.slice();
    let best = null;
    sections.forEach((section) => {
      const spec = dictionary.fields[section];
      if (!spec) return;
      Object.keys(spec.fields).forEach((key) => {
        const path = M.pathOf(dictionary, section, key, field);
        if (!path || !(path in paths) || !M.pathAllowed(dictionary, field, path)) return;
        spec.fields[key].forEach((alias) => {
          const hit = M.score(field, alias);
          if (!hit.score) return;
          if (!best || hit.score > best.confidence) {
            best = {
              path,
              confidence: Number(hit.score.toFixed(4)),
              source: hit.source,
              alias,
              matchedText: hit.matchedText,
            };
          }
        });
      });
    });
    if (!best) return { path: '', band: 'manual', confidence: 0, reason: '未找到对应的资料项，需人工填写' };
    const { auto, review } = dictionary.confidence;
    if (best.confidence >= auto) return Object.assign(best, { band: 'auto', reason: '' });
    if (best.confidence >= review) return Object.assign(best, { band: 'review', reason: '匹配把握不大，已填写并标记待确认' });
    return { path: '', band: 'manual', confidence: best.confidence, reason: '匹配把握不足，需人工填写' };
  };

  // Groups detected controls by section for the popup summary (PRD §8).
  M.categories = (dictionary, fields) => {
    const order = dictionary.scalarSections.concat(dictionary.repeatedSections);
    const counts = {};
    fields.forEach((field) => {
      const section = field.section || 'personal_information';
      counts[section] = (counts[section] || 0) + 1;
    });
    return order
      .filter((section) => counts[section])
      .map((section) => {
        const spec = dictionary.fields[section] || {};
        return { section, title: spec.title || section, count: counts[section] };
      });
  };

  /**
   * Build the fill plan for a scanned page.
   * `fields` come from the DOM scanner, `paths` from the stored profile.
   */
  M.plan = (dictionary, paths, fields, options) => {
    const settings = options || {};
    const matched = [];
    const manual = [];
    // One entry per radio group: the engine resolves the whole group from any member,
    // so counting every radio would report "性别 2 项" and fill the group twice.
    const groups = new Set();
    const usable = fields.filter((field) => {
      if (field.type !== 'radio') return true;
      const groupKey = [field.section, field.row_index, field.radioName || field.label].join('|');
      if (groups.has(groupKey)) return false;
      groups.add(groupKey);
      return true;
    });
    usable.forEach((field) => {
      const hit = M.matchField(dictionary, paths, field);
      const entry = {
        key: field.key || M.key(field),
        label: field.label,
        section: field.section,
        row_index: field.row_index,
        type: field.type,
        tag: field.tag,
        option: field.option || '',
        elementId: field.elementId,
      };
      if (hit.path) matched.push(Object.assign(entry, hit));
      else manual.push(Object.assign(entry, hit));
    });
    const plan = {
      url: settings.url || '',
      title: settings.title || '',
      detected: fields.length,
      total: usable.length,
      matched,
      manual,
      categories: M.categories(dictionary, fields),
    };
    if (settings.aiMap) M.applyAI(dictionary, paths, plan, settings.aiMap);
    plan.matchedFields = plan.matched.length;
    plan.manualFields = plan.manual.length;
    return plan;
  };

  /**
   * Promote AI-suggested paths (returned by the local API, which is the only holder
   * of the model key) for controls the dictionary could not resolve. Every AI answer
   * is re-validated against the same path rules before it is accepted.
   */
  M.applyAI = (dictionary, paths, plan, aiMap) => {
    const merged = [];
    plan.manual.forEach((entry) => {
      const path = aiMap[entry.key] || aiMap[entry.elementId];
      const field = { section: entry.section, row_index: entry.row_index, label: entry.label, type: entry.type };
      if (!path || !(path in paths) || !M.pathAllowed(dictionary, field, path)) {
        merged.push(entry);
        return;
      }
      plan.matched.push(
        Object.assign({}, entry, {
          path,
          confidence: 0.8,
          source: 'ai',
          band: 'review',
          reason: '由 AI 建议映射，已填写并标记待确认',
        }),
      );
    });
    plan.manual = merged;
  };

  RAF.matcher = M;
})(globalThis.RAF);

/* ---- extension/scanner/domScanner.js ---- */

/* DOM scanner (PRD §9).
 *
 * Extends `recruitment/static/scan.js` — the scanner used by the Playwright build —
 * so both engines describe a control identically, and adds the extra context the
 * extension needs: raw data-* attributes, sibling text, nearby text, radio options
 * and a stable cross-rescan key.
 *
 * Descriptors are plain JSON: they are posted to the popup and (for the AI fallback)
 * to the local API, never the DOM nodes themselves.
 */
(function (RAF) {
  'use strict';

  const S = RAF.selectors;
  const D = {};

  // elementId -> element. Kept in memory instead of writing a data-* attribute onto
  // the page: the job site's own MutationObserver must not see our bookkeeping.
  const registry = new Map();

  D.reset = () => registry.clear();
  D.resolve = (elementId) => registry.get(elementId) || null;
  D.size = () => registry.size;

  // Controls that are never described, let alone filled: a password field is a login
  // wall (reported through `obstacle`), and the rest are not data entry.
  const BLOCKED_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'password'];

  function siblingText(el) {
    const parts = [];
    for (let node = el.previousElementSibling, i = 0; node && i < 2; i += 1, node = node.previousElementSibling) {
      if (!node.querySelector(S.SELECTORS.controls)) parts.push(S.text(node, 60));
    }
    for (let node = el.nextElementSibling, i = 0; node && i < 2; i += 1, node = node.nextElementSibling) {
      if (!node.querySelector(S.SELECTORS.controls)) parts.push(S.text(node, 60));
    }
    return S.tidy(parts.join(' ')).slice(0, 120);
  }

  function dataAttributes(el) {
    const attributes = {};
    Array.from(el.attributes || []).forEach((attr) => {
      if (attr.name.indexOf('data-') === 0 && attr.name.indexOf('data-raf') !== 0) {
        attributes[attr.name] = String(attr.value || '').slice(0, 80);
      }
    });
    const label = ['data-label', 'data-field', 'data-name', 'data-title', 'data-placeholder']
      .map((name) => el.getAttribute(name))
      .filter(Boolean)
      .join(' ');
    return { attributes, dataLabel: S.tidy(label).slice(0, 120) };
  }

  D.describe = (el, specs, counters) => {
    if (!S.visible(el)) return null;
    const role = el.getAttribute('role');
    const isCombobox = role === 'combobox' || !!(el.closest && el.closest('[role="combobox"]'));
    const type = isCombobox
      ? 'combobox'
      : el.type || (el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase());
    if (BLOCKED_TYPES.indexOf(type) !== -1) return null;
    if (role === 'combobox' && el.querySelector && el.querySelector('input')) return null;

    const container = S.container(el);
    const labelledBy = String(el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter(Boolean);
    const own = S.labelText(el.labels && el.labels[0])
      || labelledBy.map((node) => S.labelText(node)).join(' ')
      || S.tidy(el.getAttribute('aria-label'));
    const groupLabel = S.labelText(container && container.querySelector(S.SELECTORS.label));
    const label = (type === 'radio' ? groupLabel || own : own || groupLabel)
      || S.tidy(el.getAttribute('placeholder'))
      || S.tidy(el.getAttribute('name'));
    if (!label) return null;

    const section = S.sectionOf(el, specs);
    const countKey = section + '|' + label;
    // Radio groups share one row; every other control advances the row counter so
    // repeated experiences map onto education.0, education.1, ... (PRD §15).
    const rowIndex = counters[countKey] || 0;
    if (type !== 'radio') counters[countKey] = rowIndex + 1;

    const nearby = [
      S.text(S.heading(container || el.parentElement), 80),
      siblingText(el),
      S.text(el.parentElement, 80),
    ]
      .filter(Boolean)
      .join(' ');
    const { attributes, dataLabel } = dataAttributes(el);

    const elementId = S.uniqueId('raf');
    registry.set(elementId, el);

    const descriptor = {
      elementId,
      tag: el.tagName.toLowerCase(),
      type,
      label: label.slice(0, 180),
      placeholder: S.tidy(el.getAttribute('placeholder')).slice(0, 180),
      name: S.tidy(el.getAttribute('name')).slice(0, 120),
      id: S.tidy(el.getAttribute('id')).slice(0, 120),
      ariaLabel: S.tidy(el.getAttribute('aria-label')).slice(0, 180),
      dataLabel,
      dataAttributes: attributes,
      nearbyText: S.tidy(nearby).slice(0, 180),
      section,
      row_index: rowIndex,
      required: !!el.required || el.getAttribute('aria-required') === 'true',
      readonly: !!el.readOnly,
      maxlength: typeof el.maxLength === 'number' ? el.maxLength : -1,
      option: type === 'radio' || type === 'checkbox' ? own.slice(0, 80) : '',
      radioName: type === 'radio' ? String(el.name || '') : '',
      currentValue: S.currentValue(el),
      filled: false,
      options: S.options(el),
    };
    descriptor.key = [
      descriptor.section || '',
      descriptor.row_index,
      descriptor.tag,
      descriptor.type,
      S.normalize(descriptor.label),
      S.normalize(descriptor.option || ''),
    ].join('|');
    return descriptor;
  };

  /**
   * Turns an iframe element into a human readable hint (PRD §19). Chrome injects the
   * content script into every frame we hold a host permission for, so a frame that
   * never answers is the one the user has to fill in by hand.
   */
  D.frames = (doc) => Array.from(doc.querySelectorAll('iframe')).map((frame, index) => {
    let accessible = false;
    try {
      accessible = !!(frame.contentDocument && frame.contentDocument.body);
    } catch (error) {
      accessible = false;
    }
    return { index, src: S.tidy(frame.getAttribute('src') || '').slice(0, 160), accessible };
  });

  /**
   * Login walls and captchas must not be automated (PRD §20). A visible password
   * field is a hard stop; a captcha is only a warning because a solved captcha
   * leaves its markup behind.
   */
  D.obstacle = (doc) => {
    const view = doc.defaultView;
    const shown = (node) => {
      const style = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
      return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    };
    const password = Array.from(doc.querySelectorAll('input[type="password"]')).find(shown);
    if (password) {
      return {
        blocked: true,
        code: 'login',
        message: '检测到登录/密码输入框，请先在页面上完成登录或验证，完成后重新点击“扫描页面”。',
      };
    }
    const captcha = doc.querySelector(
      'input[autocomplete="one-time-code"],input[name*="captcha"],input[name*="verifyCode"],input[id*="captcha"],' +
      'img[src*="captcha"],iframe[src*="captcha"],[class*="captcha"],[class*="Captcha"],[class*="verify-slider"],[class*="slider-verify"]',
    );
    if (captcha) {
      return {
        blocked: false,
        code: 'captcha',
        message: '页面包含验证码/人机验证区域，系统不会绕过。请先手动完成验证，未识别的字段请人工填写。',
      };
    }
    return null;
  };

  /** Scan the current document. `specs` is the schema exported from the Python side. */
  D.scan = (doc, specs) => {
    registry.clear();
    const counters = {};
    const fields = [];
    const seen = new Set();
    Array.from(doc.querySelectorAll(S.SELECTORS.controls)).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const descriptor = D.describe(el, specs, counters);
      if (descriptor) fields.push(descriptor);
    });
    const obstacle = D.obstacle(doc);
    const frames = D.frames(doc);
    return {
      url: String(doc.location ? doc.location.href : ''),
      title: S.tidy(doc.title),
      fields,
      frames,
      blocked: !!(obstacle && obstacle.blocked),
      obstacle,
      isTop: !(doc.defaultView && doc.defaultView.parent && doc.defaultView.parent !== doc.defaultView),
    };
  };

  RAF.scanner = D;
})(globalThis.RAF);

/* ---- extension/scanner/jdScanner.js ---- */

/* 岗位信息 / JD 识别。
 *
 * 自动填写解决的是"把资料搬进表单"，但用户真正要管理的其实是"这个岗位是什么"。
 * OfferLink 那条链路的关键一环就在这里：打开岗位页时顺便把公司、岗位、城市、薪资、
 * 截止时间和 JD 摘要读出来，用户确认后才进工作台。
 *
 * 只读，不写。识别结果一律先给用户看，由用户决定要不要存——宁可留空，也不猜。
 */
(function (RAF) {
  'use strict';

  const S = RAF.selectors;
  const J = {};

  const MAX_SUMMARY = 400;

  /* ---------- 已知招聘平台：只用于标注来源，不代表"已适配" ---------- */
  const PLATFORMS = [
    ['boards.greenhouse.io', 'Greenhouse'],
    ['job-boards.greenhouse.io', 'Greenhouse'],
    ['jobs.lever.co', 'Lever'],
    ['myworkdayjobs.com', 'Workday'],
    ['successfactors.com', 'SuccessFactors'],
    ['zhiye.com', '北森'],
    ['mokahr.com', 'Moka'],
    ['jobs.feishu.cn', '飞书招聘'],
    ['dayhr.com', 'daydao'],
    ['zhaopin.com', '智联招聘'],
    ['51job.com', '前程无忧'],
    ['lagou.com', '拉勾'],
    ['bosszhipin.com', 'BOSS 直聘'],
    ['liepin.com', '猎聘'],
  ];

  const stripTags = (html) => S.tidy(
    String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  );

  const safeJson = (text) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  };

  const textOf = (value) => {
    if (typeof value === 'string') return S.tidy(value);
    if (value && typeof value === 'object') return S.tidy(value.name || value['@value'] || '');
    return '';
  };

  /** JSON-LD JobPosting 是最可靠的一档：结构化、无需猜测选择器。 */
  function fromJsonLd(doc) {
    const found = {};
    Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).forEach((node) => {
      const data = safeJson(node.textContent || '');
      if (!data) return;
      (function walk(item) {
        if (Array.isArray(item)) {
          item.forEach(walk);
          return;
        }
        if (!item || typeof item !== 'object') return;
        const types = [].concat(item['@type'] || item.type || []);
        if (types.some((t) => String(t).toLowerCase() === 'jobposting') && !found.position) {
          found.position = textOf(item.title);
          found.company = textOf(item.hiringOrganization);
          found.location = textOf(item.jobLocation && item.jobLocation.address
            ? (item.jobLocation.address.addressLocality || item.jobLocation.address.addressRegion)
            : item.jobLocation);
          const salary = item.baseSalary;
          if (salary) {
            const value = salary.value || salary;
            const currency = textOf(value.currency || salary.currency || '');
            const low = value.minValue;
            const high = value.maxValue;
            if (low || high) {
              const unit = String(value.unitText || '').toUpperCase();
              found.salary = [low, high].filter(Boolean).join('-')
                + (unit === 'MONTH' || unit === 'MONTHLY' ? '/月' : '')
                + (currency ? ' ' + currency : '');
            } else {
              found.salary = textOf(value);
            }
          }
          found.deadline = textOf(item.validThrough || item.expirationDate);
          found.summary = stripTags(item.description).slice(0, MAX_SUMMARY);
        }
        Object.keys(item).forEach((key) => walk(item[key]));
      }(data));
    });
    return found.position || found.company ? found : null;
  }

  const metaContent = (doc, names) => {
    for (let i = 0; i < names.length; i += 1) {
      const node = doc.querySelector('meta[property="' + names[i] + '"],meta[name="' + names[i] + '"]');
      const value = node && S.tidy(node.getAttribute('content') || '');
      if (value) return value;
    }
    return '';
  };

  /** Open Graph / description：比选择器稳，但通常只有标题和一段简介。 */
  function fromMeta(doc) {
    return {
      position: '',
      company: metaContent(doc, ['og:site_name', 'application-name']),
      summary: metaContent(doc, ['og:description', 'description']).slice(0, MAX_SUMMARY),
    };
  }

  const firstText = (doc, selectors) => {
    for (let i = 0; i < selectors.length; i += 1) {
      const node = doc.querySelector(selectors[i]);
      const value = node ? S.tidy(S.text(node)) : '';
      if (value && value.length < 120) return value;
    }
    return '';
  };

  /** 通用选择器：覆盖大多数企业招聘站的 class 命名习惯。 */
  function fromSelectors(doc) {
    return {
      position: firstText(doc, [
        '[class*="job-title"]', '[class*="jobTitle"]', '[class*="jobtitle"]',
        '[class*="position-name"]', '[class*="positionName"]', '[class*="post-name"]',
        '[class*="job-name"]', '[class*="jobName"]', 'h1',
      ]),
      company: firstText(doc, [
        '[class*="company-name"]', '[class*="companyName"]', '[class*="company_name"]',
        '[class*="org-name"]', '[class*="employer"]', '[class*="recruiter"]',
      ]),
      location: firstText(doc, ['[class*="job-location"]', '[class*="location"]', '[class*="work-city"]', '[class*="city"]']),
      salary: firstText(doc, ['[class*="salary"]', '[class*="pay-range"]', '[class*="wage"]']),
    };
  }

  /* 标题兜底："岗位名 - 公司"、"公司 · 岗位名" 都常见。
     只在能从域名或页面里确认其中一半时才拆，否则整条当岗位名。 */
  function fromTitle(doc, knownCompany) {
    const title = S.tidy(doc.title || '');
    if (!title) return {};
    const parts = title.split(/\s*[|·\-–—_]\s*/).map((part) => S.tidy(part)).filter(Boolean);
    if (parts.length < 2) return { position: title.replace(/\s*[-–—|].*$/, '').trim() };
    if (knownCompany) {
      const rest = parts.filter((part) => part.indexOf(knownCompany) === -1);
      if (rest.length) return { position: rest[0], company: knownCompany };
    }
    // 约定俗成：站点名通常放在最后一段。
    return { position: parts[0], company: parts[parts.length - 1] };
  }

  const DATE_HINT = /(20\d{2}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}|截止[^。；\n]{0,20}|deadline[^。；\n]{0,20})/i;

  function findDeadline(doc) {
    const node = doc.querySelector('[class*="deadline"],[class*="expire"],[class*="valid-until"],[class*="end-date"]');
    const direct = node ? S.tidy(S.text(node)) : '';
    if (direct && DATE_HINT.test(direct)) return direct.slice(0, 60);
    const body = S.tidy(S.text(doc.body || doc.documentElement || doc));
    const matched = body.match(DATE_HINT);
    return matched ? matched[1].slice(0, 60) : '';
  }

  /* 页面标题里常见的导航词。把"登录""职位列表"当成岗位名只会污染工作台，
     宁可这一格空着让用户自己填。 */
  const NOISE = new Set([
    '登录', '注册', '登录/注册', '首页', '主页', '招聘', '职位', '职位列表', '职位搜索',
    '校园招聘', '社会招聘', '个人中心', '我的', '简历', '职位详情', '首页 ',
    'join us', 'careers', 'jobs', 'home', 'login', 'sign in', 'signin',
  ]);
  const clean = (value) => {
    const tidy = S.tidy(value);
    return tidy && !NOISE.has(tidy.toLowerCase()) ? tidy : '';
  };

  J.platformOf = (url) => {
    const host = String(url || '').toLowerCase();
    const hit = PLATFORMS.find(([suffix]) => host.indexOf(suffix) !== -1);
    return hit ? hit[1] : '';
  };

  /**
   * 识别页面上的岗位信息。
   * 各来源按可靠度叠加：JSON-LD > meta > 选择器 > 标题。先命中的优先，
   * 后面的只补空位，避免低质量来源覆盖结构化数据。
   */
  J.detect = (doc) => {
    const url = String(doc.location ? doc.location.href : '');
    const layers = [
      Object.assign({ source: 'jsonld' }, fromJsonLd(doc) || {}),
      Object.assign({ source: 'meta' }, fromMeta(doc)),
      Object.assign({ source: 'selector' }, fromSelectors(doc)),
      Object.assign({ source: 'title' }, fromTitle(doc, J.platformOf(url))),
    ];
    const result = {
      company: '', position: '', location: '', salary: '', deadline: '',
      summary: '', platform: J.platformOf(url), source: 'none', confidence: 0, url,
    };
    let primary = 'none';
    ['company', 'position', 'location', 'salary', 'deadline', 'summary'].forEach((key) => {
      layers.some((layer) => {
        if (!layer[key]) return false;
        result[key] = layer[key];
        if ((key === 'position' || key === 'company') && primary === 'none') primary = layer.source;
        return true;
      });
    });
    result.position = clean(result.position);
    result.company = clean(result.company);
    if (!result.deadline) result.deadline = findDeadline(doc);
    if (!result.company) result.company = J.platformOf(url);
    result.source = primary;
    // 置信度只用来提示"要不要人工核对"，不驱动任何自动写入。一个字段都没认出来就是 0，
    // 绝不因为来源是结构化数据就凭空抬高分。
    const filled = ['company', 'position', 'location', 'salary'].filter((key) => result[key]).length;
    result.confidence = filled ? Math.min(1, filled / 4 + (primary === 'jsonld' ? 0.25 : 0)) : 0;
    return result;
  };

  RAF.jd = J;
})(globalThis.RAF);

/* ---- extension/autofill/submitGuard.js ---- */

/* Submit Guard (PRD §17) — the one rule that must never break.
 *
 * Two independent layers:
 *   1. `assertClickable` / `isSubmitBlocked` gate every programmatic click, so the
 *      only buttons automation ever presses are "add another row" style ones.
 *   2. While a fill is in progress the guard arms itself and swallows `submit()`,
 *      `requestSubmit()` and `submit` events, so a page that auto-submits on the
 *      last field cannot end the application behind the user's back.
 *
 * Arming is scoped to the fill window only: the human's own click afterwards is
 * never intercepted.
 */
(function (RAF) {
  'use strict';

  const S = RAF.selectors;
  const G = {};

  const installedProtos = new WeakSet();
  const blockedAttempts = [];
  let armed = false;
  let onBlocked = null;

  // Arming is the moment the guard has to be live, so install on the frame's own
  // document when one was not passed: a caller that only has a handler must still be
  // protected. `install` is idempotent per prototype.
  G.arm = (handler, doc) => {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    if (target) G.install(target);
    armed = true;
    onBlocked = handler || null;
  };

  G.disarm = () => {
    armed = false;
    onBlocked = null;
  };

  G.armed = () => armed;

  G.blockedAttempts = () => blockedAttempts.slice();

  G.resetAttempts = () => {
    blockedAttempts.length = 0;
  };

  // Every string a user would read on the button.
  G.buttonText = (el) => {
    if (!el) return '';
    return S.tidy(
      [
        el.innerText,
        el.textContent,
        el.value,
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('title'),
        el.getAttribute && el.getAttribute('name'),
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  G.isSubmitBlocked = (dictionary, el) => {
    const text = G.buttonText(el);
    if (!text) return false;
    return new RegExp(dictionary.rules.submitBlocked, 'i').test(text);
  };

  // PRD §16: "添加/新增/展开/更多" may be clicked; nothing else.
  G.isNavAllowed = (dictionary, el) => {
    const text = G.buttonText(el);
    if (!text) return false;
    if (G.isSubmitBlocked(dictionary, el)) return false;
    return new RegExp(dictionary.rules.navButton, 'i').test(text);
  };

  G.assertClickable = (dictionary, el) => {
    if (G.isSubmitBlocked(dictionary, el)) {
      const error = new Error('已拦截对“提交/投递”类按钮的自动点击');
      error.code = 'SUBMIT_BLOCKED';
      throw error;
    }
    return true;
  };

  function record(target, via) {
    blockedAttempts.push({ via, url: String((target && target.ownerDocument && target.ownerDocument.location) || '') });
    if (onBlocked) {
      try {
        onBlocked(via);
      } catch (error) {
        /* a notice must never break the fill */
      }
    }
  }

  /**
   * Patches the form prototype of the page so automation cannot submit. Called once
   * per frame; the patch is inert until `arm()`.
   */
  G.install = (doc) => {
    const view = doc.defaultView;
    const proto = view && view.HTMLFormElement && view.HTMLFormElement.prototype;
    if (!proto || installedProtos.has(proto)) return;
    installedProtos.add(proto);
    ['submit', 'requestSubmit'].forEach((name) => {
      const original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function guardedSubmit() {
        if (armed) {
          record(this, name);
          return undefined;
        }
        return original.apply(this, arguments);
      };
    });
    doc.addEventListener(
      'submit',
      (event) => {
        if (!armed) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        record(event.target, 'submit-event');
      },
      true,
    );
  };

  /** A safe click helper: mousedown/mouseup/click, blocked for submit buttons. */
  G.click = (dictionary, el, options) => {
    const settings = options || {};
    if (!el) return false;
    if (settings.guarded !== false) G.assertClickable(dictionary, el);
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      const Ctor = view.MouseEvent || view.Event;
      let event;
      try {
        event = new Ctor(type, { bubbles: true, cancelable: true, composed: true, view });
      } catch (error) {
        event = new view.Event(type, { bubbles: true });
      }
      el.dispatchEvent(event);
    });
    return true;
  };

  RAF.guard = G;
})(globalThis.RAF);

/* ---- extension/autofill/highlight.js ---- */

/* Page highlight feedback (PRD §21).
 *
 * After a fill the user has to be able to tell, without reading the popup, which fields
 * the tool wrote, which it was unsure about, and which it deliberately left alone.
 *
 * `outline` is used instead of `border` so nothing reflows, and no attribute the site
 * cares about is overwritten: the only DOM change is our own mark attribute plus the
 * inline outline, both restored by `clear()`.
 */
(function (RAF) {
  'use strict';

  const H = {};

  const MARK = 'data-raf-mark';
  const LEGEND_ID = 'raf-legend';
  const BANDS = {
    filled: { color: '#16a34a', text: '已填写' },
    review: { color: '#d97706', text: '待确认' },
    manual: { color: '#dc2626', text: '需人工' },
  };

  // element -> { outline, offset } so clearing restores what the page had, not "".
  const painted = new Map();

  H.BANDS = BANDS;
  H.markedCount = () => painted.size;

  H.mark = (el, band) => {
    const spec = BANDS[band];
    if (!el || !spec || !el.style) return false;
    if (!painted.has(el)) {
      painted.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
    }
    el.style.outline = '2px solid ' + spec.color;
    el.style.outlineOffset = '1px';
    el.setAttribute(MARK, band);
    return true;
  };

  H.clear = () => {
    painted.forEach((saved, el) => {
      try {
        el.style.outline = saved.outline;
        el.style.outlineOffset = saved.offset;
        el.removeAttribute(MARK);
      } catch (error) {
        /* the page navigated away mid-clear; nothing left to restore */
      }
    });
    painted.clear();
    H.hideLegend();
  };

  /* A single non-interactive legend explaining the colours, so a colour alone never
   * has to carry the meaning. Pointer events are disabled: it must never swallow a
   * click meant for the form. */
  H.showLegend = (doc, counts) => {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    if (!target || !target.body) return;
    H.hideLegend();
    const box = target.createElement('div');
    box.id = LEGEND_ID;
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'pointer-events:none', 'font:12px/1.6 system-ui,-apple-system,sans-serif',
      'background:rgba(17,24,39,.92)', 'color:#fff', 'padding:8px 10px',
      'border-radius:8px', 'box-shadow:0 4px 14px rgba(0,0,0,.25)', 'max-width:220px',
    ].join(';');
    const rows = Object.keys(BANDS)
      .map((band) => {
        const n = counts && counts[band] ? counts[band] : 0;
        return (
          '<div style="display:flex;align-items:center;gap:6px">' +
          '<span style="width:8px;height:8px;border-radius:2px;background:' + BANDS[band].color + '"></span>' +
          '<span>' + BANDS[band].text + (n ? ' ' + n : '') + '</span></div>'
        );
      })
      .join('');
    box.innerHTML =
      '<div style="font-weight:600;margin-bottom:4px">简历填表助手</div>' + rows +
      '<div style="opacity:.7;margin-top:6px">提交/投递按钮始终由你手动点击</div>';
    target.body.appendChild(box);
  };

  H.hideLegend = () => {
    const box = typeof document !== 'undefined' && document.getElementById(LEGEND_ID);
    if (box && box.parentNode) box.parentNode.removeChild(box);
  };

  RAF.highlight = H;
})(globalThis.RAF);

/* ---- extension/autofill/autofillEngine.js ---- */

/* Autofill engine (PRD §13, §14).
 *
 * Writes a value the way a human keyboard interaction would, then *verifies* what the
 * page accepted and reports back. Nothing here ever clicks a submit/apply button —
 * every click goes through `RAF.guard`.
 *
 * Supported controls: text/number/tel/email inputs, textarea, contenteditable,
 * native select, radio groups, checkbox, native date/month inputs and the custom
 * dropdowns shipped by Ant Design / Element Plus / Arco / TDesign, which are plain
 * divs rather than <select>.
 */
(function (RAF) {
  'use strict';

  const S = RAF.selectors;
  const E = RAF.events;
  const G = RAF.guard;
  const A = {};

  // Public framework class conventions. No site-proprietary selector is invented.
  const OPTION_SELECTORS = [
    '[role="option"]',
    '.ant-select-item-option',
    '.el-select-dropdown__item',
    '.arco-select-option',
    '.t-select-option',
    'li[class*="option"]',
    '[class*="dropdown"] li',
    '[class*="Dropdown"] li',
  ].join(',');

  A.OPTION_SELECTORS = OPTION_SELECTORS;

  // Port of matching.formatted(): never invent precision the profile does not have.
  A.format = (entry, value) => {
    const text = String(value == null ? '' : value);
    if (entry.type === 'month' && !/^\d{4}-\d{2}$/.test(text)) throw new Error('月份精度不一致，需要人工确认');
    if (entry.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('资料只有月份，不能推测具体日期');
    if (typeof entry.maxlength === 'number' && entry.maxlength >= 0 && text.length > entry.maxlength) {
      throw new Error('内容超过网站字数限制，保留原文并交给人工缩减');
    }
    return text;
  };

  /** The value plus every equivalent spelling it may appear as on a page. */
  A.equivalents = (dictionary, value) => {
    const out = [S.tidy(value)];
    const target = S.normalize(value);
    if (!target) return out;
    (dictionary.valueGroups || []).forEach((group) => {
      const hit = group.aliases.some((alias) => {
        const candidate = S.normalize(alias);
        return candidate && (candidate === target || target.includes(candidate) || candidate.includes(target));
      });
      if (hit) group.aliases.forEach((alias) => out.push(alias));
    });
    return out;
  };

  A.scoreOption = (text, wanted) => {
    const norm = S.normalize(text);
    if (!norm) return 0;
    let best = 0;
    wanted.forEach((candidate) => {
      const target = S.normalize(candidate);
      if (!target) return;
      if (norm === target) best = Math.max(best, 1);
      else if (norm.includes(target) || target.includes(norm)) best = Math.max(best, 0.7);
    });
    return best;
  };

  A.escape = (el) => {
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
    const Ctor = view.KeyboardEvent || view.Event;
    try {
      el.dispatchEvent(new Ctor('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    } catch (error) {
      /* older engines: nothing else to do */
    }
  };

  A.fillSelect = (dictionary, el, value) => {
    const wanted = A.equivalents(dictionary, value);
    let picked = null;
    let score = 0;
    Array.from(el.options || []).forEach((option) => {
      if (option.disabled) return;
      const byValue = S.normalize(option.value) === S.normalize(value) ? 1 : 0;
      const hit = Math.max(byValue, A.scoreOption(option.label || option.textContent, wanted));
      if (hit > score) {
        score = hit;
        picked = option;
      }
    });
    if (!picked || score < 0.7) return { status: 'manual', reason: '下拉框中没有匹配的选项，需人工选择' };
    E.setValue(el, picked.value);
    E.fire(el, 'input');
    E.fire(el, 'change');
    E.fire(el, 'blur');
    return { status: 'filled', actual: S.tidy(picked.label || picked.textContent) };
  };

  A.radioLabel = (radio) => {
    const own = radio.labels && radio.labels[0] ? S.labelText(radio.labels[0]) : '';
    const container = S.container(radio) || radio.parentElement;
    const fromContainer = S.labelText(container && container.querySelector(S.SELECTORS.label));
    return S.tidy([own, container === radio.parentElement ? '' : fromContainer, radio.getAttribute('aria-label')].filter(Boolean).join(' '));
  };

  A.radioGroup = (el) => {
    const name = el.name;
    if (!name) return [el];
    const scope = el.form || el.ownerDocument;
    return Array.from(scope.querySelectorAll('input[type="radio"]')).filter(
      (node) => node.name === name && !node.disabled && S.visible(node),
    );
  };

  A.fillRadio = (dictionary, el, value) => {
    const wanted = A.equivalents(dictionary, value);
    const group = A.radioGroup(el);
    let picked = null;
    let score = 0;
    group.forEach((radio) => {
      const hit = Math.max(A.scoreOption(radio.value, wanted), A.scoreOption(A.radioLabel(radio), wanted));
      if (hit > score) {
        score = hit;
        picked = radio;
      }
    });
    if (!picked || score < 0.7) return { status: 'manual', reason: '没有匹配的单选选项，需人工选择' };
    group.forEach((radio) => {
      if (radio !== picked && radio.checked) E.commitChecked(radio, false);
    });
    E.commitChecked(picked, true);
    return { status: 'filled', actual: A.radioLabel(picked) || picked.value };
  };

  A.fillCheckbox = (dictionary, el, value) => {
    const truthy = /^(1|true|yes|是|同意|接受)$/i.test(S.tidy(value));
    E.commitChecked(el, truthy);
    return { status: 'filled', actual: truthy ? '已勾选' : '已取消勾选' };
  };

  A.findOption = (doc, wanted) => {
    let picked = null;
    let score = 0;
    Array.from(doc.querySelectorAll(OPTION_SELECTORS)).forEach((node) => {
      if (!S.visible(node)) return;
      if (node.getAttribute('aria-disabled') === 'true') return;
      if (String(node.className || '').indexOf('disabled') !== -1) return;
      const hit = A.scoreOption(E.optionText(node), wanted);
      if (hit > score) {
        score = hit;
        picked = node;
      }
    });
    return score >= 0.7 ? picked : null;
  };

  A.fillCombobox = async (dictionary, el, value) => {
    const wanted = A.equivalents(dictionary, value);
    const doc = el.ownerDocument;
    if (el.tagName === 'INPUT' && !el.readOnly) {
      E.commit(el, value);
      const option = await E.waitFor(() => A.findOption(doc, wanted), { timeout: 600 });
      if (option) {
        G.click(dictionary, option);
        E.fire(el, 'change');
        return { status: 'filled', actual: E.optionText(option) };
      }
      if (S.normalize(S.currentValue(el)) === S.normalize(value)) return { status: 'filled', actual: value };
      A.escape(el);
      return { status: 'manual', reason: '自定义下拉框未能匹配选项，需人工选择' };
    }
    G.click(dictionary, el);
    const option = await E.waitFor(() => A.findOption(doc, wanted), { timeout: 1200 });
    if (!option) {
      A.escape(el);
      return { status: 'manual', reason: '自定义下拉框未能匹配选项，需人工选择' };
    }
    G.click(dictionary, option);
    E.fire(el, 'change');
    return { status: 'filled', actual: E.optionText(option) };
  };

  A.verify = (el, expected) => {
    const actual = S.tidy(S.currentValue(el));
    if (S.normalize(actual) === S.normalize(expected)) return { status: 'filled', actual };
    if (!actual) return { status: 'manual', reason: '写入后页面未接受该值，需要人工填写' };
    if (S.normalize(actual).indexOf(S.normalize(expected)) === 0) return { status: 'filled', actual };
    return { status: 'manual', reason: '页面把内容改写为“' + actual.slice(0, 40) + '”，需要人工核对' };
  };

  /** Fill a single planned entry. Returns a report row, never throws. */
  A.fillEntry = async (dictionary, entry, options) => {
    const settings = options || {};
    const values = settings.values || {};
    const row = {
      key: entry.key,
      label: entry.label,
      path: entry.path,
      band: entry.band,
      confidence: entry.confidence,
      elementId: entry.elementId,
    };
    const value = values[entry.path];
    const el = RAF.scanner.resolve(entry.elementId);
    if (!el || !el.isConnected) {
      return Object.assign(row, { status: 'manual', reason: '页面结构已变化，请重新扫描' });
    }
    if (value == null || String(value).trim() === '') {
      return Object.assign(row, { status: 'manual', reason: '资料中该字段为空' });
    }
    const current = S.tidy(S.currentValue(el));
    if (!settings.overwrite && current && S.normalize(current) !== S.normalize(value)) {
      return Object.assign(row, { status: 'skipped', reason: '该字段已有内容，未覆盖' });
    }
    let text;
    try {
      text = A.format(entry, value);
    } catch (error) {
      return Object.assign(row, { status: 'manual', reason: error.message });
    }
    try {
      if (el.isContentEditable) {
        E.commit(el, text);
        return Object.assign(row, A.verify(el, text));
      }
      if (el.tagName === 'SELECT') return Object.assign(row, A.fillSelect(dictionary, el, text));
      if (entry.type === 'radio') return Object.assign(row, A.fillRadio(dictionary, el, text));
      if (entry.type === 'checkbox') return Object.assign(row, A.fillCheckbox(dictionary, el, text));
      if (entry.type === 'combobox') return Object.assign(row, await A.fillCombobox(dictionary, el, text));
      if (el.readOnly) {
        return Object.assign(row, { status: 'manual', reason: '只读输入框（多为自定义选择器），需要人工选择' });
      }
      E.commit(el, text);
      const result = A.verify(el, text);
      if (result.status !== 'filled' && (entry.type === 'month' || entry.type === 'date')) {
        return Object.assign(row, { status: 'manual', reason: '日期选择器未能写入，需要人工选择' });
      }
      return Object.assign(row, result);
    } catch (error) {
      const reason = error && error.code === 'SUBMIT_BLOCKED' ? '检测到提交类按钮，已拦截' : String((error && error.message) || error);
      return Object.assign(row, { status: 'manual', reason });
    }
  };

  /**
   * Fill every approved entry. Sequential on purpose: a page that reacts to one
   * field must settle before the next one is written.
   */
  A.fillPlan = async (dictionary, entries, values, options) => {
    const settings = Object.assign({ overwrite: false, gap: 30 }, options || {});
    G.arm(settings.onBlocked);
    G.resetAttempts();
    const results = [];
    for (let i = 0; i < entries.length; i += 1) {
      results.push(await A.fillEntry(dictionary, entries[i], Object.assign({}, settings, { values })));
      if (i < entries.length - 1) await E.sleep(settings.gap);
    }
    G.disarm();
    return { results, blockedAttempts: G.blockedAttempts() };
  };

  RAF.engine = A;
})(globalThis.RAF);

/* ---- 字段词典：由 recruitment/dictionary.py 生成 ---- */

globalThis.RAF_DEMO_DICTIONARY = {"source": "recruitment/profile.py::SCHEMA", "scalarSections": ["personal_information", "other"], "repeatedSections": ["education", "experience", "campus", "projects"], "sectionOrder": ["personal_information", "education", "experience", "projects", "campus", "other"], "fields": {"personal_information": {"title": "基本信息", "aliases": [], "fields": {"full_name": ["姓名", "真实姓名", "中文姓名", "full name", "name"], "gender": ["性别", "gender", "sex"], "date_of_birth": ["出生日期", "出生年月日", "生日", "date of birth", "birthday"], "phone": ["手机号", "手机号码", "联系电话", "手机", "电话", "phone", "mobile"], "email": ["邮箱", "电子邮箱", "电子邮件", "email", "e-mail"], "city": ["现居城市", "现居住地", "所在城市", "居住城市", "city"], "address_line": ["详细地址", "联系地址", "address"], "nationality": ["国籍", "nationality"], "native_place": ["籍贯", "户籍所在地", "native place", "hometown"], "political_status": ["政治面貌", "政治身份", "political status"]}}, "education": {"title": "教育经历", "aliases": ["教育背景", "education"], "fields": {"school": ["学校", "毕业院校", "院校名称", "学校名称", "school", "university"], "degree": ["学历", "最高学历", "degree"], "field_of_study": ["专业", "专业名称", "major", "field of study"], "gpa": ["绩点", "gpa"], "start": ["入学时间", "开始时间", "开始日期", "start date"], "end": ["毕业时间", "结束时间", "结束日期", "end date"], "current": ["在读", "仍在进行"], "description": ["在校表现", "描述", "description"]}}, "experience": {"title": "实习经历", "aliases": ["工作经历", "工作经验", "实习经验", "work experience", "employment", "internship"], "fields": {"company": ["公司", "公司名称", "实习单位", "工作单位", "company", "employer"], "title": ["职位", "岗位", "职位名称", "实习岗位", "job title", "title"], "start": ["开始时间", "开始日期", "入职时间", "start date"], "end": ["结束时间", "结束日期", "离职时间", "end date"], "current": ["仍在职", "至今", "仍在进行"], "description": ["工作内容", "实习内容", "工作描述", "职责描述", "工作职责", "description"]}}, "campus": {"title": "校园经历", "aliases": ["校园实践", "社团经历", "学生工作", "campus", "activities"], "fields": {"organization": ["组织名称", "社团名称", "组织", "社团", "organization"], "title": ["担任职务", "职务", "职位", "角色", "title", "role"], "start": ["开始时间", "开始日期", "start date"], "end": ["结束时间", "结束日期", "end date"], "current": ["至今", "仍在进行"], "description": ["活动内容", "职责描述", "经历描述", "描述", "description"]}}, "projects": {"title": "项目经历", "aliases": ["项目经验", "projects"], "fields": {"name": ["项目名称", "名称", "project name"], "title": ["项目角色", "担任角色", "角色", "role"], "start": ["开始时间", "开始日期", "start date"], "end": ["结束时间", "结束日期", "end date"], "current": ["至今", "仍在进行"], "description": ["项目描述", "项目内容", "项目职责", "描述", "description"]}}, "other": {"title": "其他信息", "aliases": [], "fields": {"skills_text": ["专业技能", "技能特长", "特长", "技能", "skills"], "hobbies": ["兴趣爱好", "个人爱好", "爱好", "hobbies"], "summary": ["自我评价", "个人评价", "个人简介", "summary", "about you"], "certifications_text": ["证书", "资格证书", "certifications"], "languages_text": ["语言能力", "外语能力", "languages"], "portfolio": ["作品集", "作品链接", "portfolio"], "job_position": ["求职意向", "期望职位", "意向岗位", "目标岗位", "应聘岗位", "desired position", "job objective"], "expected_city": ["期望城市", "期望工作城市", "意向城市", "期望工作地点", "preferred city", "preferred location"], "available_date": ["到岗时间", "可到岗时间", "最快到岗时间", "available date", "available from"]}}}, "valueGroups": [{"id": "gender.male", "aliases": ["男", "男性", "男生", "male", "man", "m", "先生"]}, {"id": "gender.female", "aliases": ["女", "女性", "女生", "female", "woman", "f", "女士"]}, {"id": "degree.highschool", "aliases": ["高中", "普通高中", "中专", "职高", "技校", "high school", "secondary"]}, {"id": "degree.associate", "aliases": ["大专", "专科", "高职", "大学专科", "associate", "associate degree", "college diploma"]}, {"id": "degree.bachelor", "aliases": ["本科", "学士", "大学本科", "本科生", "全日制本科", "bachelor", "bachelors", "bachelor's", "undergraduate", "bs", "ba"]}, {"id": "degree.master", "aliases": ["硕士", "研究生", "硕士研究生", "全日制硕士", "master", "masters", "master's", "msc", "ms", "ma", "postgraduate"]}, {"id": "degree.doctor", "aliases": ["博士", "博士研究生", "doctor", "doctorate", "phd", "dphil"]}, {"id": "political.party", "aliases": ["中共党员", "党员", "中国共产党党员", "预备党员", "中共预备党员", "communist party"]}, {"id": "political.league", "aliases": ["共青团员", "团员", "中国共产主义青年团团员", "league member"]}, {"id": "political.masses", "aliases": ["群众", "普通群众", "无党派人士", "masses", "none"]}, {"id": "experience.current", "aliases": ["至今", "今", "现在", "目前", "present", "current", "now", "ongoing"]}], "rules": {"sensitive": "密码|验证码|证件|身份证|护照|银行|银行卡|薪资|薪酬|期望工资|背景调查|犯罪|推荐人|紧急联系人|password|verification|passport|\\bssn\\b|bank|salary|sponsorship|consent|captcha", "forbiddenButton": "提交|投递|申请|确认|完成|下一步|登录|注册|submit|apply|confirm|finish|next|sign|register", "submitBlocked": "提交|投递|申请|确认投递|确认提交|立即申请|发送简历|submit|apply|send application|finish application", "navButton": "^[＋+\\s]*(添加|新增|展开|更多|add|add another|new)", "blockedInputTypes": ["password", "checkbox", "hidden", "submit", "button", "reset", "search", "file", "image"]}, "confidence": {"auto": 0.85, "review": 0.6}, "version": "2b081539bc0a"};
