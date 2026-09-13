'use strict';

/* 在线工作台：资料与任务清单仅保存在本机浏览器的 localStorage 中，不上传服务器。 */

const STORE_KEY = 'resume-autofill.workbench.v1';

const SCHEMA = {
  personal_information: {
    title: '基本信息', repeat: false,
    fields: [
      { key: 'full_name', label: '姓名', type: 'text' },
      { key: 'gender', label: '性别', type: 'select', options: ['', '男', '女', '其他'] },
      { key: 'date_of_birth', label: '出生日期', type: 'date' },
      { key: 'phone', label: '手机号码', type: 'tel' },
      { key: 'email', label: '电子邮箱', type: 'email' },
      { key: 'city', label: '现居城市', type: 'text' },
      { key: 'address_line', label: '详细地址', type: 'text' },
      { key: 'nationality', label: '国籍', type: 'text' },
    ],
  },
  education: {
    title: '教育经历', repeat: true,
    fields: [
      { key: 'school', label: '学校', type: 'text' },
      { key: 'degree', label: '学历', type: 'text' },
      { key: 'field_of_study', label: '专业', type: 'text' },
      { key: 'gpa', label: '绩点', type: 'text' },
      { key: 'start', label: '入学时间', type: 'month' },
      { key: 'end', label: '毕业时间', type: 'month' },
      { key: 'current', label: '在读', type: 'checkbox' },
      { key: 'description', label: '在校表现', type: 'textarea' },
    ],
  },
  experience: {
    title: '实习 / 工作经历', repeat: true,
    fields: [
      { key: 'company', label: '公司名称', type: 'text' },
      { key: 'title', label: '职位', type: 'text' },
      { key: 'start', label: '开始时间', type: 'month' },
      { key: 'end', label: '结束时间', type: 'month' },
      { key: 'current', label: '仍在职', type: 'checkbox' },
      { key: 'description', label: '工作内容', type: 'textarea' },
    ],
  },
  campus: {
    title: '校园经历', repeat: true,
    fields: [
      { key: 'organization', label: '组织 / 社团名称', type: 'text' },
      { key: 'title', label: '担任职务', type: 'text' },
      { key: 'start', label: '开始时间', type: 'month' },
      { key: 'end', label: '结束时间', type: 'month' },
      { key: 'current', label: '仍在进行', type: 'checkbox' },
      { key: 'description', label: '活动内容', type: 'textarea' },
    ],
  },
  projects: {
    title: '项目经历', repeat: true,
    fields: [
      { key: 'name', label: '项目名称', type: 'text' },
      { key: 'title', label: '担任角色', type: 'text' },
      { key: 'start', label: '开始时间', type: 'month' },
      { key: 'end', label: '结束时间', type: 'month' },
      { key: 'current', label: '仍在进行', type: 'checkbox' },
      { key: 'description', label: '项目描述', type: 'textarea' },
    ],
  },
  other: {
    title: '其他信息', repeat: false,
    fields: [
      { key: 'skills_text', label: '专业技能', type: 'textarea' },
      { key: 'hobbies', label: '兴趣爱好', type: 'textarea' },
      { key: 'summary', label: '自我评价', type: 'textarea' },
      { key: 'certifications_text', label: '证书', type: 'textarea' },
      { key: 'languages_text', label: '语言能力', type: 'textarea' },
      { key: 'portfolio', label: '作品集链接', type: 'text' },
    ],
  },
};

const STATUS = [['todo', '待处理'], ['filled', '已填写'], ['submitted', '已投递']];

const DEMO_PROFILE = {
  personal_information: {
    full_name: '林知遥', gender: '女', date_of_birth: '2002-05-16',
    phone: '13800000000', email: 'lin.zhiyao@example.com',
    city: '杭州市', address_line: '', nationality: '中国',
  },
  education: [{
    school: '示例大学', degree: '本科', field_of_study: '计算机科学与技术', gpa: '3.8 / 4.0',
    start: '2020-09', end: '2024-06', current: false,
    description: '主修课程：数据结构、操作系统、数据库原理、机器学习。',
  }],
  experience: [{
    company: '示例科技有限公司', title: '前端开发实习生', start: '2023-07', end: '2023-12',
    current: false, description: '参与内部管理后台开发，负责表单配置与数据看板模块。',
  }],
  campus: [{
    organization: '示例大学计算机协会', title: '技术部干事', start: '2021-09', end: '2022-06',
    current: false, description: '组织每学期的技术分享与编程练习活动。',
  }],
  projects: [{
    name: '校园二手书交易平台', title: '前端负责人', start: '2023-03', end: '2023-06',
    current: false, description: '使用 React 与 Node.js 实现商品发布、检索与订单流程。',
  }],
  skills_text: 'HTML / CSS / JavaScript / React / Git',
  hobbies: '长跑、摄影',
  summary: '计算机专业应届生，注重细节与代码质量，具备完整的前端项目实践经历。',
  certifications_text: '',
  languages_text: '英语 CET-6',
  portfolio: '',
};

const DEMO_TASKS = [
  'https://careers.example.com/job/frontend-intern',
  'https://jobs.example.org/campus/2026/resume',
  'https://campus.example.net/apply/software-engineer',
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let profile = {};
let tasks = [];
let toastTimer = null;

/* ---------- 数据 ---------- */

function blankRow(spec) {
  const row = {};
  spec.fields.forEach((f) => { row[f.key] = f.type === 'checkbox' ? false : ''; });
  return row;
}

function emptyProfile() {
  const out = {};
  for (const [section, spec] of Object.entries(SCHEMA)) {
    if (spec.repeat) out[section] = [];
    else if (section === 'other') Object.assign(out, blankRow(spec));
    else out[section] = blankRow(spec);
  }
  return out;
}

function normalizeProfile(raw) {
  const base = emptyProfile();
  if (!raw || typeof raw !== 'object') return base;
  const src = { ...raw };
  const pi = { ...(src.personal_information || {}) };

  // 兼容本机版与上游仓库的旧字段命名
  if (!pi.full_name && (pi.first_name || pi.last_name)) {
    pi.full_name = [pi.first_name, pi.middle_name, pi.last_name].filter(Boolean).join(' ');
  }
  if (src.skills && typeof src.skills === 'object' && !Array.isArray(src.skills) && !src.skills_text) {
    src.skills_text = Object.values(src.skills).flat().filter(Boolean).join('；');
  } else if (Array.isArray(src.skills) && !src.skills_text) {
    src.skills_text = src.skills.filter(Boolean).join('；');
  }
  if (!src.certifications_text && Array.isArray(src.certifications)) {
    src.certifications_text = src.certifications.filter(Boolean).join('；');
  }
  if (!src.languages_text && Array.isArray(src.spoken_languages)) {
    src.languages_text = src.spoken_languages
      .map((r) => (typeof r === 'string' ? r : Object.values(r || {}).filter(Boolean).join(' ')))
      .join('；');
  }
  if (!src.portfolio && src.links && typeof src.links === 'object') {
    src.portfolio = src.links.portfolio || '';
  }

  for (const f of SCHEMA.personal_information.fields) {
    const v = pi[f.key];
    if (v !== undefined && v !== null) base.personal_information[f.key] = String(v);
  }
  for (const f of SCHEMA.other.fields) {
    const v = src[f.key];
    if (v !== undefined && v !== null && String(v).trim() !== '') base[f.key] = String(v);
  }

  for (const [section, spec] of Object.entries(SCHEMA)) {
    if (!spec.repeat) continue;
    const rows = Array.isArray(src[section]) ? src[section] : [];
    base[section] = rows.filter((r) => r && typeof r === 'object').map((r) => {
      const row = blankRow(spec);
      spec.fields.forEach((f) => {
        if (f.type === 'checkbox') { row[f.key] = !!r[f.key]; return; }
        let v = r[f.key];
        if ((v === undefined || v === null || v === '') && f.key === 'start' && r.start_year) v = r.start_year;
        if ((v === undefined || v === null || v === '') && f.key === 'end') {
          v = r.end_year || r.graduation_year || '';
        }
        row[f.key] = v === undefined || v === null ? '' : String(v);
      });
      if (row.current) row.end = '';
      return row;
    });
  }
  return base;
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ profile, tasks }));
    $('save-note').textContent = '已保存到本机浏览器 · ' + new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    toast('浏览器存储不可用，请及时导出 JSON 备份。', true);
  }
}

/* ---------- 通用 UI ---------- */

function toast(text, isError) {
  const el = $('toast');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('is-error', !!isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 资料编辑 ---------- */

function getRow(section, index) {
  if (section === 'other') return profile;
  if (SCHEMA[section].repeat) return profile[section][index];
  return profile[section];
}

function fieldHTML(section, cfg, value, index) {
  const id = `f-${section}-${index === null ? 'x' : index}-${cfg.key}`;
  const attrs = `data-section="${section}" data-key="${cfg.key}"${index === null ? '' : ` data-index="${index}"`}`;

  if (cfg.type === 'checkbox') {
    return `<div class="check"><input id="${id}" type="checkbox" ${attrs} ${value ? 'checked' : ''}>`
      + `<label for="${id}">${esc(cfg.label)}</label></div>`;
  }
  if (cfg.type === 'textarea') {
    return `<div class="wide"><label for="${id}">${esc(cfg.label)}</label>`
      + `<textarea id="${id}" rows="2" ${attrs}>${esc(value)}</textarea></div>`;
  }
  if (cfg.type === 'select') {
    const options = cfg.options
      .map((o) => `<option value="${esc(o)}" ${String(value) === o ? 'selected' : ''}>${esc(o || '不填写')}</option>`)
      .join('');
    return `<div><label for="${id}">${esc(cfg.label)}</label><select id="${id}" ${attrs}>${options}</select></div>`;
  }
  return `<div><label for="${id}">${esc(cfg.label)}</label>`
    + `<input id="${id}" type="${cfg.type}" ${attrs} value="${esc(value)}"></div>`;
}

function renderEditor() {
  $('profile-editor').innerHTML = Object.entries(SCHEMA).map(([section, spec]) => {
    if (!spec.repeat) {
      const row = section === 'other' ? profile : profile[section];
      const grid = `<div class="grid">${spec.fields.map((f) => fieldHTML(section, f, row[f.key], null)).join('')}</div>`;
      return `<article class="card"><div class="card-head"><h2>${esc(spec.title)}</h2></div>${grid}</article>`;
    }
    const rows = profile[section];
    const entries = rows.map((row, i) => (
      `<div class="entry">
        <div class="entry-head"><strong>第 ${i + 1} 条</strong>
          <button type="button" data-remove="${section}" data-index="${i}">删除</button></div>
        <div class="grid">${spec.fields.map((f) => fieldHTML(section, f, row[f.key], i)).join('')}</div>
      </div>`
    )).join('');
    const hint = rows.length ? '' : '<p class="hint" style="margin:0">尚未添加，可从真实经历开始填写。</p>';
    return `<article class="card"><div class="card-head"><h2>${esc(spec.title)}</h2>`
      + `<button type="button" class="btn" data-add="${section}">＋ 添加</button></div>${entries}${hint}</article>`;
  }).join('');
}

function onEdit(e) {
  const el = e.target;
  const { section, key, index } = el.dataset;
  if (!section || !key) return;
  const row = getRow(section, index === undefined ? null : Number(index));
  if (!row) return;

  row[key] = el.type === 'checkbox' ? el.checked : el.value;

  if (key === 'current' && row[key]) {
    row.end = '';
    const end = el.closest('.entry')?.querySelector('[data-key="end"]');
    if (end) end.value = '';
  }
  if (key === 'end' && row[key]) {
    row.current = false;
    const cur = el.closest('.entry')?.querySelector('[data-key="current"]');
    if (cur) cur.checked = false;
  }
  save();
}

$('profile-editor').addEventListener('input', onEdit);
$('profile-editor').addEventListener('change', onEdit);

$('profile-editor').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.add) {
    const section = btn.dataset.add;
    profile[section].push(blankRow(SCHEMA[section]));
  } else if (btn.dataset.remove) {
    profile[btn.dataset.remove].splice(Number(btn.dataset.index), 1);
  } else {
    return;
  }
  save();
  renderEditor();
});

/* ---------- 资料导入导出 ---------- */

$('import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    profile = normalizeProfile(raw);
    save();
    renderEditor();
    toast('已导入资料，请核对每一项后继续使用。');
  } catch (err) {
    toast('JSON 文件无法解析，请确认是从本页或本机版导出的档案。', true);
  }
});

$('export-json').addEventListener('click', () => {
  download(profile, 'profile.json');
  toast('已导出 profile.json，可导入本机版或作为备份。');
});

$('demo-profile').addEventListener('click', () => {
  const isBlank = JSON.stringify(profile) === JSON.stringify(emptyProfile());
  if (!isBlank && !window.confirm('载入示例会替换当前资料，确定继续？')) return;
  profile = normalizeProfile(DEMO_PROFILE);
  save();
  renderEditor();
  toast('已载入示例资料（虚构数据），可直接修改为你的真实内容。');
});

$('clear-profile').addEventListener('click', () => {
  if (!window.confirm('确定清空全部资料？此操作不可撤销，建议先导出备份。')) return;
  profile = emptyProfile();
  save();
  renderEditor();
  toast('已清空资料。');
});

/* ---------- 任务清单 ---------- */

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function renderTasks() {
  $('task-count').textContent = tasks.length + ' 个';
  const list = $('task-list');
  if (!tasks.length) {
    list.innerHTML = '<div class="empty">还没有任务。在上方粘贴招聘网址，点击「添加到清单」。</div>';
    return;
  }
  list.innerHTML = tasks.map((t, i) => (
    `<div class="task">
      <span class="idx">${i + 1}</span>
      <div class="info">
        <a class="url" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url)}</a>
        <div class="domain">${esc(hostOf(t.url))}</div>
      </div>
      <select data-status="${t.id}" aria-label="投递进度">
        ${STATUS.map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="del" data-del="${t.id}" aria-label="删除该任务">✕</button>
    </div>`
  )).join('');
}

function addUrls(rawText) {
  const urls = String(rawText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { toast('请先粘贴至少一个招聘网址。', true); return; }

  const invalid = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
  if (invalid) { toast('网址需要以 http:// 或 https:// 开头：' + invalid, true); return; }

  let added = 0;
  let duplicated = 0;
  for (const url of urls) {
    if (tasks.some((t) => t.url === url)) { duplicated++; continue; }
    tasks.push({ id: uid(), url, status: 'todo' });
    added++;
  }
  save();
  renderTasks();

  if (added) {
    toast(`已添加 ${added} 个网址` + (duplicated ? `，跳过 ${duplicated} 个重复项。` : '。'));
  } else {
    toast('这些网址已经在清单中。');
  }
}

$('add-tasks').addEventListener('click', () => {
  const input = $('task-urls');
  addUrls(input.value);
  input.value = '';
});

$('demo-tasks').addEventListener('click', () => {
  addUrls(DEMO_TASKS.join('\n'));
});

$('task-list').addEventListener('change', (e) => {
  const id = e.target.dataset.status;
  if (!id) return;
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = e.target.value;
  save();
});

$('task-list').addEventListener('click', (e) => {
  const id = e.target.dataset.del;
  if (!id) return;
  tasks = tasks.filter((t) => t.id !== id);
  save();
  renderTasks();
});

$('export-tasks').addEventListener('click', () => {
  if (!tasks.length) { toast('清单还是空的。', true); return; }
  download({ exported_at: new Date().toISOString(), tasks }, 'recruitment-tasks.json');
  toast('已导出招聘任务清单。');
});

$('clear-tasks').addEventListener('click', () => {
  if (!tasks.length) { toast('清单还是空的。', true); return; }
  if (!window.confirm('确定清空全部任务？资料不会被删除。')) return;
  tasks = [];
  save();
  renderTasks();
  toast('已清空任务清单。');
});

/* ---------- 导航与初始化 ---------- */

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + btn.dataset.tab; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

const stored = load();
profile = normalizeProfile(stored.profile);
tasks = Array.isArray(stored.tasks)
  ? stored.tasks.filter((t) => t && typeof t.url === 'string' && t.url)
    .map((t) => ({ id: t.id || uid(), url: t.url, status: STATUS.some(([v]) => v === t.status) ? t.status : 'todo' }))
  : [];

renderEditor();
renderTasks();
