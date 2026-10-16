import { createApp, reactive, ref, computed, watch, watchEffect, nextTick } from '/vendor/vue.js';
import Fuse from '/vendor/fuse.js';
import Sortable from '/vendor/sortable.js';
import { pinyin } from '/vendor/pinyin/index.mjs';

// ---------- 小工具 ----------
async function request(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'X-Nav': '1', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    keepalive: method !== 'GET',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  }
  return res;
}

const stored = (key, fallback) => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key)) };
  } catch {
    return fallback;
  }
};

const hostCache = new Map();
function host(link) {
  // 详情页关掉后，它的图标加载事件可能才回来，这时已经没有对应的网址了
  if (!link) return '';
  if (!hostCache.has(link.url)) {
    let h = link.url;
    try {
      h = new URL(link.url).host.replace(/^www\./, '');
    } catch {}
    hostCache.set(link.url, h);
  }
  return hostCache.get(link.url);
}

function color(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 42% 62%)`;
}

// 浏览器导出的 Netscape 书签格式：<DT><H3>文件夹</H3><DL> … <DT><A HREF>
function parseBookmarks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 一个书签所在的文件夹路径，如「开发/前端」。最多保留三层，更深的并进第三层
  const pathOf = (a) => {
    const names = [];
    let inToolbar = false;
    for (let dl = a.closest('dl'); dl; dl = dl.parentElement?.closest('dl')) {
      let h = dl.previousElementSibling;
      while (h && h.tagName !== 'H3') h = h.previousElementSibling;
      h ||= dl.parentElement?.querySelector(':scope > h3');
      // Firefox 拖出文件夹时用的是 <DL><DT>文件夹名</DT><DD><A>…
      h ||= [...dl.children].find((el) => el.tagName === 'DT' && !el.querySelector('a'));
      if (!h) continue;
      // 「书签栏」这一层人人都有，留着只会白占一层，去掉
      if (h.hasAttribute('personal_toolbar_folder')) inToolbar = true;
      else names.unshift(h.textContent.trim().replaceAll('/', '／'));
    }
    return names.filter(Boolean).slice(0, 3).join('/') || (inToolbar ? '书签栏' : '');
  };
  return [...doc.querySelectorAll('a[href]')]
    .filter((a) => /^https?:\/\//i.test(a.getAttribute('href')))
    .map((a) => ({ url: a.getAttribute('href'), title: a.textContent.trim(), category: pathOf(a) }));
}

// 从浏览器拖进来的内容：书签、地址栏网址、网页上的链接，Firefox 还能拖整个书签文件夹
function readDrop(dt) {
  // 浏览器会同时给出几种格式，而且各格式里的条数可能不一样（比如多选书签时
  // text/uri-list 只有第一条、text/plain 才是全部），所以每种都读、按网址合并
  const found = new Map();
  const add = (url, title = '', category = '') => {
    url = url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const old = found.get(url);
    if (!old) found.set(url, { url, title, category });
    else Object.assign(old, { title: old.title || title, category: old.category || category });
  };
  for (const item of parseBookmarks(dt.getData('text/html'))) add(item.url, item.title, item.category);
  // text/x-moz-url 是「网址、标题」逐行交替
  const moz = dt.getData('text/x-moz-url').split(/\r?\n/);
  for (let i = 0; i < moz.length; i += 2) add(moz[i], moz[i + 1]);
  for (const line of dt.getData('text/uri-list').split(/\r?\n/)) add(line);
  for (const line of dt.getData('text/plain').split(/\r?\n/)) add(line);
  // 留一条调试信息：拖进来的条数不对时，可以看浏览器到底给了什么
  console.debug('[nav] 收到', found.size, '个网址；原始数据：', Object.fromEntries([...dt.types].map((t) => [t, dt.getData(t)])));
  return [...found.values()];
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非 HTTPS 的局域网地址没有 clipboard API
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------- 指令与组件 ----------
// SortableJS 直接改 DOM，会和 Vue 的列表渲染打架：拖完先把节点放回原位，再改数据让 Vue 重排。
// 卡片被拖到侧栏分类上时由 catDrop 处理，这里告诉 Sortable 的收尾逻辑不要再动数据
let dropHandled = false;

const vSortable = {
  mounted(el, { value }) {
    let next;
    el._sortable = Sortable.create(el, {
      animation: 150,
      group: value.group,
      draggable: '[data-id]',
      disabled: !value.enabled,
      ghostClass: 'drag-ghost',
      // 触屏上长按留给操作菜单，不启动拖拽排序（否则滑动页面时会误拖）
      delay: 1e6,
      delayOnTouchOnly: true,
      onStart: (e) => (next = e.item.nextSibling),
      onEnd(e) {
        const changed = e.from !== e.to || e.oldDraggableIndex !== e.newDraggableIndex;
        if (changed) e.from.insertBefore(e.item, next);
        if (!changed || dropHandled) return;
        el._onMove({ id: Number(e.item.dataset.id), from: e.from.dataset.cat, to: e.to.dataset.cat, index: e.newDraggableIndex });
      },
    });
    el._onMove = value.onMove;
  },
  updated(el, { value }) {
    el._sortable.option('disabled', !value.enabled);
    el._onMove = value.onMove;
  },
  unmounted(el) {
    el._sortable.destroy();
  },
};

// 触屏长按 = 右键。iOS 长按不会触发 contextmenu，所以自己计时；手指移动或抬起就取消。
const vHold = {
  mounted(el, { value }) {
    let timer;
    let start;
    const cancel = () => clearTimeout(timer);
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return cancel();
        const { clientX, clientY } = (start = e.touches[0]);
        timer = setTimeout(() => {
          el._held = true;
          navigator.vibrate?.(8);
          el._onHold({ clientX, clientY, target: e.target, preventDefault() {}, stopPropagation() {} });
        }, 450);
      },
      { passive: true }
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        const t = e.touches[0];
        if (Math.abs(t.clientX - start.clientX) > 8 || Math.abs(t.clientY - start.clientY) > 8) cancel();
      },
      { passive: true }
    );
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
    // 长按松手后浏览器可能还会补一次点击，不能让它打开网址
    el.addEventListener(
      'click',
      (e) => {
        if (!el._held) return;
        el._held = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );
    el._onHold = value;
  },
  updated(el, { value }) {
    el._onHold = value;
  },
};

// 带「小眼睛」的密码输入框：点一下显示明文，方便核对有没有输错
const PwInput = {
  props: { modelValue: String, placeholder: String, autocomplete: String, autofocus: Boolean },
  emits: ['update:modelValue'],
  data: () => ({ show: false }),
  mounted() {
    if (this.autofocus) this.$refs.input.focus();
  },
  template: `
    <span class="pw">
      <input ref="input" class="input" :type="show ? 'text' : 'password'" :value="modelValue" :placeholder="placeholder"
             :autocomplete="autocomplete" @input="$emit('update:modelValue', $event.target.value)">
      <button type="button" class="ib" tabindex="-1" :title="show ? '隐藏密码' : '显示密码'" @click="show = !show">
        <i class="ic" :class="show ? 'ic-eye' : 'ic-eye-off'"></i>
      </button>
    </span>`,
};

const Modal = {
  props: { title: String, width: String },
  emits: ['close'],
  // 弹窗打开时把焦点移进来（表单里的输入框已自己聚焦的不动）。否则焦点还留在背后刚点过的卡片上，
  // 按 Enter 触发的是那张卡片，而不是弹窗里的确认按钮
  mounted() {
    if (!this.$el.contains(document.activeElement)) {
      (this.$el.querySelector('footer .btn:last-child') || this.$el.querySelector('header .ib')).focus();
    }
  },
  template: `
    <div class="mask" @mousedown.self="$emit('close')">
      <div class="modal" :style="{ width }" role="dialog" aria-modal="true">
        <header><h2>{{ title }}</h2><button class="ib" title="关闭" @click="$emit('close')"><i class="ic ic-x"></i></button></header>
        <slot name="head" />
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.foot"><slot name="foot" /></footer>
      </div>
    </div>`,
};

const secretList = (value) => value ? (Array.isArray(value) ? value : [value]) : [];
const emptySecret = () => ({ account: '', password: '', note: '', extra: [] });

createApp({
  setup() {
    // ---------- 偏好（只存本机） ----------
    const prefs = reactive(
      stored('nav.prefs', {
        theme: 'auto',
        density: 'cozy',
        accent: '#4f7fd9',
        view: 'card',
        icons: true,
        newTab: true,
        sidebar: window.innerWidth > 760,
        mode: null,
        newPrivate: true,
        // 工作模式：隐藏 NSFW 网址（默认开着，任何人打开都是安全的）
        // NSFW 显示方式：work 隐藏 / blur 模糊 / full 完全显示
        nsfwMode: 'work',
        // 收起状态：sideFolded 是侧栏里收起了子分类的分类，folded 是主页面里收起的小节
        sideFolded: {},
        folded: {},
      })
    );
    // 窄屏上侧栏是盖在内容上的抽屉，每次打开页面都先收起
    if (window.innerWidth <= 760) prefs.sidebar = false;
    const accents = ['#4f7fd9', '#3f9a86', '#6f9a4a', '#d98a3d', '#d6678c', '#8a6cd6'];
    const media = matchMedia('(prefers-color-scheme: dark)');
    const systemDark = ref(media.matches);
    media.addEventListener('change', (e) => (systemDark.value = e.matches));
    const isDark = computed(() => (prefs.theme === 'auto' ? systemDark.value : prefs.theme === 'dark'));
    // 明暗切换用浏览器的视图过渡做一次交叉淡入淡出，不直接硬切。
    // 首次进入（boot.js 已设好）、用户关闭了动效、或浏览器不支持时直接切换。
    watch(isDark, (dark) => {
      const apply = () => (document.documentElement.dataset.theme = dark ? 'dark' : 'light');
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // 页面在后台等情况下过渡会被浏览器跳过（主题照样会切），不必把它当错误抛出来
        const t = document.startViewTransition(apply);
        t.ready.catch(() => {});
        t.finished.catch(() => {});
      } else {
        apply();
      }
    });
    document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light';
    watchEffect(() => {
      const root = document.documentElement;
      root.dataset.density = prefs.density;
      root.style.setProperty('--ac', prefs.accent);
      localStorage.setItem('nav.prefs', JSON.stringify(prefs));
    });
    const toggleTheme = () => (prefs.theme = isDark.value ? 'light' : 'dark');

    // ---------- 状态 ----------
    const st = reactive({
      loading: true,
      error: '',
      setup: true,
      authorized: false,
      viaIp: false,
      ip: '',
      title: '导航',
      logo: '',
      categories: [],
      links: [],
      settings: {},
    });
    const priv = computed(() => st.authorized && prefs.mode !== 'public');

    const toast = ref(null);
    let toastTimer;
    function say(text) {
      toast.value = { id: Date.now(), text };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.value = null), 2000);
    }

    async function api(method, url, body) {
      try {
        return await (await request(method, url, body)).json();
      } catch (e) {
        // 401 有两种：登录状态失效，或者只是某个需要再次验证密码的操作里密码输错了。
        // 不靠接口地址去猜，直接问服务端现在还算不算已登录，只有真的失效了才退回公开模式
        if (e.status === 401 && url !== '/login' && st.authorized) {
          const state = await request('GET', '/state').then((r) => r.json()).catch(() => null);
          if (state && !state.authorized) {
            st.authorized = false;
            say('管理员模式已失效，请重新进入');
            loadData().catch(() => {});
          }
        }
        throw e;
      }
    }

    async function loadData() {
      const data = await api('GET', '/data?mode=' + (priv.value ? 'private' : 'public') + '&work=' + (prefs.nsfwMode === 'work' ? 1 : 0));
      st.categories = data.categories;
      // 服务端还是旧版本（没重启）时返回的数据没有 categories，补上以免整页渲染失败
      for (const l of data.links) {
        l.categories ??= l.category_id != null ? [l.category_id] : [];
        l.pos ??= {};
      }
      st.links = data.links;
      // 已不存在的网址从多选里剔除；离开管理员模式时直接退出多选
      const alive = new Set(data.links.map((l) => l.id));
      for (const id of [...sel]) if (!alive.has(id)) sel.delete(id);
      if (!priv.value) exitSel();
      st.settings = data.settings;
      document.title = st.title;
      if (nav.type === 'recent' && !priv.value) nav.type = 'all';
      if (nav.type === 'cat' && nav.id !== null && !catById.value.has(nav.id)) nav.type = 'all';
      if (!priv.value && ['clicks'].includes(sort.value)) sort.value = 'custom';
      if (!priv.value) vis.value = 'all';
    }

    async function load() {
      st.loading = true;
      st.error = '';
      try {
        Object.assign(st, await api('GET', '/state'));
        await loadData();
      } catch (e) {
        st.error = e.message;
      } finally {
        st.loading = false;
      }
    }

    // ---------- 浏览：导航、筛选、排序、搜索 ----------
    const nav = reactive({ type: 'all', id: null });
    const query = ref('');
    const tag = ref(null);
    const tagsOpen = ref(false);
    const vis = ref('all');
    const sort = ref('custom');
    const menuOpen = ref(false);
    const searchEl = ref(null);

    // ---------- 分类树（最多三层） ----------
    const MAX_DEPTH = 3;
    const catById = computed(() => new Map(st.categories.map((c) => [c.id, c])));
    // 每个分类下面的子分类，按顺序排好；上级不在列表里的（理论上不会有）当作顶层
    const catKids = computed(() => {
      const map = new Map();
      for (const c of st.categories) {
        const key = catById.value.has(c.parent_id) ? c.parent_id : null;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(c);
      }
      for (const list of map.values()) list.sort((a, b) => a.sort - b.sort || a.id - b.id);
      return map;
    });
    const kidsOf = (id) => catKids.value.get(id) || [];
    // 从顶层到自己的一串
    const catChain = (id) => {
      const chain = [];
      for (let c = catById.value.get(id); c && chain.length < 10; c = catById.value.get(c.parent_id)) chain.unshift(c);
      return chain;
    };
    const catName = (id) => catById.value.get(id)?.name || '';
    const catPath = (id) => catChain(id).map((c) => c.name).join('/'); // 给接口用
    const catLabel = (id) => catChain(id).map((c) => c.name).join(' / '); // 给人看
    const catDepth = (id) => catChain(id).length;
    const catHeight = (id) => 1 + Math.max(0, ...kidsOf(id).map((c) => catHeight(c.id)));
    // 自己或任何一级上级私密，就算私密
    const catPrivate = (id) => catChain(id).some((c) => c.private);
    // 分类或它任何一级上级标了 NSFW
    const catNsfw = (id) => catChain(id).some((c) => c.nsfw);
    // 卡片的悬停提示：名称、网址、描述，各占一行（重复的不再显示）
    const cardTip = (l) => [...new Set([l.title, l.url, l.desc].map((t) => t?.trim()).filter(Boolean))].join('\n');
    const isNsfw = (l) => !!l && (l.nsfw || l.categories.some(catNsfw));
    const subtreeIds = (id) => [id, ...kidsOf(id).flatMap((c) => subtreeIds(c.id))];
    // 整棵树按显示顺序排成一列，带层级
    const catOrder = computed(() => {
      const out = [];
      const walk = (parentId, depth) =>
        kidsOf(parentId).forEach((cat) => {
          out.push({ cat, depth });
          walk(cat.id, depth + 1);
        });
      walk(null, 0);
      return out;
    });
    const hasNested = computed(() => st.categories.some((c) => catById.value.has(c.parent_id)));
    // 侧栏里实际显示的行：上级被收起的不显示
    const sideCats = computed(() => catOrder.value.filter(({ cat }) => !catChain(cat.id).slice(0, -1).some((c) => prefs.sideFolded[c.id])));
    const toggleSideFold = (id) => (prefs.sideFolded[id] ? delete prefs.sideFolded[id] : (prefs.sideFolded[id] = true));
    const toggleFold = (id) => (prefs.folded[id] ? delete prefs.folded[id] : (prefs.folded[id] = true));
    // 用缩进表示层级的下拉 / 菜单文字
    const indent = (depth, name) => '　'.repeat(depth) + name;

    // 所属分类全是私密分类的网址，公开模式下同样看不到
    const isPrivate = (l) => l.private || (l.categories.length > 0 && l.categories.every(catPrivate));

    // 每个分类的网址数：包含它下面各级子分类里的，同一个网址只算一次
    const catCount = computed(() => {
      const count = { none: 0 };
      for (const l of st.links) {
        if (!l.categories.length) count.none++;
        const ids = new Set(l.categories.flatMap((id) => catChain(id).map((c) => c.id)));
        for (const id of ids) count[id] = (count[id] || 0) + 1;
      }
      return count;
    });
    const pinnedCount = computed(() => st.links.filter((l) => l.pinned).length);
    const recentCount = computed(() => Math.min(30, st.links.filter((l) => l.last_visit).length));
    const tagList = computed(() => {
      const count = new Map();
      for (const l of st.links) for (const t of l.tags) count.set(t, (count.get(t) || 0) + 1);
      return [...count].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count);
    });

    // 模糊搜索交给 Fuse；中文名额外索引全拼和首字母
    const fuse = computed(() => {
      const docs = st.links.map((l) => {
        const cjk = /[一-鿿]/.test(l.title);
        return {
          link: l,
          title: l.title,
          host: host(l),
          desc: l.desc,
          tags: l.tags,
          cat: l.categories.map(catLabel),
          py: cjk ? pinyin(l.title, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('') : '',
          initials: cjk ? pinyin(l.title, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('') : '',
        };
      });
      return new Fuse(docs, {
        threshold: 0.3,
        ignoreLocation: true,
        keys: [
          { name: 'title', weight: 3 },
          { name: 'py', weight: 2 },
          { name: 'initials', weight: 2 },
          { name: 'host', weight: 2 },
          { name: 'tags', weight: 2 },
          { name: 'cat', weight: 1 },
          { name: 'desc', weight: 1 },
        ],
      });
    });

    // 每个分类有各自的顺序（pos），未分类的用 sort
    const posIn = (catId) => (a, b) => (catId == null ? a.sort - b.sort : (a.pos[catId] ?? 1e9) - (b.pos[catId] ?? 1e9)) || a.id - b.id;
    const sorters = {
      custom: (a, b) => posIn(nav.type === 'cat' ? nav.id : null)(a, b),
      clicks: (a, b) => b.clicks - a.clicks,
      name: (a, b) => a.title.localeCompare(b.title, 'zh-CN'),
    };

    const shown = computed(() => {
      let list;
      if (query.value) {
        // 搜索总是全局的，并保持相关度顺序
        list = fuse.value.search(query.value).map((r) => r.item.link);
      } else if (nav.type === 'recent') {
        list = st.links.filter((l) => l.last_visit).sort((a, b) => b.last_visit - a.last_visit).slice(0, 30);
      } else {
        // 看某个分类时，它下面各级子分类里的网址也算在内
        const inside = nav.type === 'cat' && nav.id !== null ? new Set(subtreeIds(nav.id)) : null;
        list = st.links.filter(
          (l) => nav.type === 'all' || (nav.type === 'pinned' ? l.pinned : inside ? l.categories.some((id) => inside.has(id)) : !l.categories.length)
        );
        list.sort(sorters[sort.value]);
      }
      if (vis.value === 'secret') list = list.filter((l) => l.has_secret);
      else if (vis.value !== 'all') list = list.filter((l) => isPrivate(l) === (vis.value === 'private'));
      if (tag.value) list = list.filter((l) => l.tags.includes(tag.value));
      return list;
    });

    const groups = computed(() => {
      const grouped = !query.value && sort.value === 'custom' && (['all', 'pinned'].includes(nav.type) || (nav.type === 'cat' && nav.id !== null));
      // 平铺视图里只有「正在看未分类」时才知道卡片来自哪，其余情况 catId 留空
      if (!grouped) return [{ key: 'flat', name: '', depth: 0, catId: nav.type === 'cat' ? nav.id : undefined, links: shown.value, all: shown.value }];
      const result = [];
      const rootId = nav.type === 'cat' ? nav.id : null;
      // 正在看某个分类时，它自己的内容不缩进、不带标题，子分类从第一层开始
      const base = rootId === null ? 0 : catDepth(rootId);
      const walk = (cat, hidden) => {
        const ids = new Set(subtreeIds(cat.id));
        const all = shown.value.filter((l) => l.categories.some((id) => ids.has(id)));
        if (!all.length) return;
        const isRoot = cat.id === rootId;
        const folded = !isRoot && !!prefs.folded[cat.id];
        if (!hidden) {
          result.push({
            key: cat.id,
            name: isRoot ? '' : cat.name,
            private: catPrivate(cat.id),
            catId: cat.id,
            depth: Math.max(0, catDepth(cat.id) - 1 - base + (rootId === null ? 0 : 1)),
            // 收起时不渲染卡片；all 是这一节连同子分类的全部网址，用于计数和全选
            links: folded ? [] : shown.value.filter((l) => l.categories.includes(cat.id)).sort(posIn(cat.id)),
            all,
            folded,
            foldable: !isRoot,
          });
        }
        kidsOf(cat.id).forEach((kid) => walk(kid, hidden || folded));
      };
      if (rootId === null) kidsOf(null).forEach((cat) => walk(cat, false));
      else walk(catById.value.get(rootId), false);
      if (rootId === null) {
        const loose = shown.value.filter((l) => !l.categories.length).sort(posIn(null));
        if (loose.length) result.push({ key: 'none', name: '未分类', depth: 0, catId: null, links: prefs.folded.none ? [] : loose, all: loose, folded: !!prefs.folded.none, foldable: true });
      }
      return result;
    });
    function foldAll(fold) {
      for (const key of Object.keys(prefs.folded)) delete prefs.folded[key];
      if (fold) for (const c of st.categories) prefs.folded[c.id] = true;
    }

    const heading = computed(() => {
      if (query.value) return `搜索「${query.value}」`;
      if (nav.type === 'cat') return nav.id === null ? '未分类' : catLabel(nav.id);
      return { all: '全部网址', pinned: '常用', recent: '最近访问' }[nav.type];
    });

    function go(type, id = null) {
      Object.assign(nav, { type, id });
      query.value = '';
      exitSel();
      if (page.id !== null) closePage();
      if (window.innerWidth <= 760) prefs.sidebar = false;
    }
    function resetFilters() {
      query.value = '';
      tag.value = null;
      vis.value = 'all';
    }

    function visit(link) {
      if (!priv.value) return;
      link.clicks++;
      link.last_visit = Date.now();
      request('POST', `/links/${link.id}/visit`).catch(() => {});
    }
    function searchEnter() {
      if (!query.value) return;
      const first = shown.value[0];
      if (first) visit(first);
      const url = first ? first.url : st.settings.search.replace('%s', encodeURIComponent(query.value));
      window.open(url, prefs.newTab ? '_blank' : '_self', 'noopener,noreferrer');
    }

    // 图标分两级：先向本站要（服务器抓好缓存的），要不到再让浏览器直接去那个网站取，都不行就显示首字
    const iconOk = reactive(new Set());
    const iconStage = reactive(new Map());
    const iconBust = reactive(new Map());
    const iconSrc = (l) =>
      !l ? '' : iconStage.get(l.id) === 1 ? new URL('/favicon.ico', l.url).href : `/icon/${l.id}?v=${l.icon_v || ''}${iconBust.get(l.id) || ''}`;
    const iconShow = (l) => !!l && prefs.icons && (iconStage.get(l.id) || 0) < 2;
    const iconLoaded = (l) => l && iconOk.add(l.id);
    function iconFailed(l) {
      if (!l) return;
      iconOk.delete(l.id);
      iconStage.set(l.id, (iconStage.get(l.id) || 0) + 1);
    }
    function iconReload(l) {
      iconOk.delete(l.id);
      iconStage.delete(l.id);
      iconBust.set(l.id, Date.now());
    }
    function uploadIcon(link) {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,.heic,.heif' });
      input.onchange = () => pickLogo(input.files[0], link);
      input.click();
    }
    async function setIcon(link, icon) {
      try {
        await api('PUT', `/links/${link.id}/icon`, { icon });
        await loadData();
        iconReload(link);
        say(icon ? '图标已更换' : '已恢复自动图标');
      } catch (e) {
        say(e.message);
      }
    }
    // 从网站上找到的全部图标里挑一个。挑中的图转成 PNG 保存为这个网址的图标（ICO、SVG 等格式统一处理）
    const iconPick = reactive({ id: null, loading: false, busy: false, icons: [], error: '', chosen: null });
    async function loadIconChoices(link, refresh = false) {
      if (!link) return;
      if (iconPick.id !== link.id) Object.assign(iconPick, { icons: [], chosen: null });
      Object.assign(iconPick, { id: link.id, loading: true, error: '' });
      try {
        const icons = (await api('GET', `/links/${link.id}/icon/candidates${refresh ? '?refresh=1' : ''}`)).icons;
        if (iconPick.id === link.id) iconPick.icons = icons.map((ic) => ({ ...ic, w: 0, h: 0 }));
      } catch (e) {
        iconPick.error = e.message;
      } finally {
        iconPick.loading = false;
      }
    }
    async function chooseIcon(link, ic, index) {
      iconPick.busy = true;
      try {
        const img = new Image();
        img.src = ic.src;
        await img.decode();
        const side = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight) || 128);
        const canvas = Object.assign(document.createElement('canvas'), { width: side, height: side });
        const scale = Math.min(side / (img.naturalWidth || side), side / (img.naturalHeight || side));
        const w = (img.naturalWidth || side) * scale;
        const h = (img.naturalHeight || side) * scale;
        canvas.getContext('2d').drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
        await setIcon(link, canvas.toDataURL('image/png'));
        iconPick.chosen = index;
      } catch {
        say('这张图无法使用，换一张试试');
      } finally {
        iconPick.busy = false;
      }
    }
    async function refetchIcon(link) {
      try {
        await api('POST', `/links/${link.id}/icon/refresh`);
        // 同一个网站的其他网址用的是同一份缓存，一起刷新
        const origin = new URL(link.url).origin;
        for (const l of st.links) if (new URL(l.url).origin === origin) iconReload(l);
        say('正在重新获取图标…');
      } catch (e) {
        say(e.message);
      }
    }

    // ---------- 公开 / 私密 ----------
    const login = reactive({ open: false, password: '', error: '', busy: false, then: null });

    function askLogin(then = null) {
      Object.assign(login, { open: true, password: '', error: '', then });
    }
    // 三档轮换：工作（隐藏）→ 模糊 → 完全
    const NSFW_MODES = {
      work: { label: '工作', next: 'blur', tip: '工作模式：NSFW 网址已隐藏' },
      blur: { label: '模糊', next: 'full', tip: '模糊模式：NSFW 网址的图标和文字打码，悬停看清' },
      full: { label: '完全', next: 'work', tip: '完全模式：显示全部网址' },
    };
    if (!NSFW_MODES[prefs.nsfwMode]) prefs.nsfwMode = 'work';
    async function toggleWork() {
      prefs.nsfwMode = NSFW_MODES[prefs.nsfwMode].next;
      await loadData();
      say('已切到' + NSFW_MODES[prefs.nsfwMode].tip);
    }
    async function toggleMode() {
      if (priv.value) {
        // 密码登录的会话直接注销；白名单设备只是切换视图
        if (!st.viaIp) {
          await api('POST', '/logout');
          st.authorized = false;
        }
        prefs.mode = 'public';
        await loadData();
        say('已切到公开模式');
      } else if (st.authorized) {
        prefs.mode = 'private';
        await loadData();
      } else if (st.setup) {
        askLogin();
      }
    }
    async function enterPrivate(path) {
      login.busy = true;
      login.error = '';
      try {
        await api('POST', path, { password: login.password });
        prefs.mode = 'private';
        login.open = false;
        login.password = '';
        await load();
        login.then?.();
      } catch (e) {
        login.error = e.message;
      } finally {
        login.busy = false;
      }
    }
    const doLogin = () => enterPrivate('/login');
    const doSetup = () => enterPrivate('/setup');

    // ---------- 通用确认 ----------
    const ask = reactive({ open: false, title: '', text: '', actions: [] });
    const confirmBox = (title, text, actions) => Object.assign(ask, { open: true, title, text, actions });

    // ---------- 账号信息 ----------
    // ---------- 详情页 ----------
    // 用地址栏的 #/link/编号 表示正在看哪个网址的详情，这样浏览器的后退键、刷新、收藏都能用
    const page = reactive({ id: null, secret: null, show: false, loading: false, error: '', editing: false, draft: null, busy: false });
    const pageLink = computed(() => (page.id === null ? null : st.links.find((l) => l.id === page.id) || null));
    const openDetail = (link) => (location.hash = '#/link/' + link.id);
    const closePage = () => (location.hash = '');
    const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

    // 账号信息只在管理员模式下按需取，离开管理员模式立刻清掉
    async function loadSecret() {
      const link = pageLink.value;
      const requestId = (page.requestId || 0) + 1;
      page.requestId = requestId;
      page.loading = false;
      page.show = false;
      page.secret = null;
      page.error = '';
      if (!link || !priv.value || !link.has_secret) return;
      page.loading = true;
      try {
        const result = await api('GET', `/links/${link.id}/secret`);
        if (page.requestId === requestId && priv.value && page.id === link.id) page.secret = result.secret;
      } catch (e) {
        if (page.requestId === requestId) page.error = e.message;
      } finally {
        if (page.requestId === requestId) page.loading = false;
      }
    }
    function readHash() {
      const id = /^#\/link\/(\d+)$/.exec(location.hash)?.[1];
      Object.assign(page, { id: id ? Number(id) : null, show: false, editing: false, draft: null });
      loadSecret();
    }
    window.addEventListener('hashchange', readHash);
    // 数据重新加载后（保存、切换公开/私密等）刷新一次账号信息
    watch(() => st.links, () => page.id !== null && loadSecret());

    function startEdit(section) {
      const d = pageLink.value.detail || {};
      page.draft = {
        summary: d.summary || '',
        features: (d.features || []).join('\n'),
        notes: d.notes || '',
        links: (d.links || []).map((l) => ({ ...l })),
      };
      page.editing = section;
    }
    // 焦点离开正在编辑的栏目（点了外面）就保存；在栏目里面点按钮不算离开
    // 不能只看 relatedTarget：点铅笔进入编辑时，铅笔按钮被移除也会触发一次 focusout。
    // 等焦点落定后再看它还在不在这一栏里
    function secBlur(e, key) {
      const sec = e.currentTarget;
      setTimeout(() => {
        if (page.editing === key && !sec.contains(document.activeElement)) saveDetail();
      });
    }
    function secCancel(key) {
      if (page.editing === key) page.editing = false;
    }
    async function saveDetail() {
      if (page.busy || !page.editing) return;
      // 没改动就直接退出编辑，不发请求
      const d = pageLink.value?.detail || {};
      const before = { summary: d.summary || '', features: (d.features || []).join('\n'), notes: d.notes || '', links: (d.links || []).map((l) => ({ ...l })) };
      if (JSON.stringify(before[page.editing]) === JSON.stringify(page.draft[page.editing])) return (page.editing = false);
      page.busy = true;
      try {
        const { summary, features, notes, links } = page.draft;
        await api('PUT', `/links/${page.id}/detail`, {
          section: page.editing,
          detail: { summary, features: features.split('\n'), notes, links: links.filter((l) => l.url.trim()) },
        });
        page.editing = false;
        await loadData();
        say('详情已保存');
      } catch (e) {
        say(e.message);
      } finally {
        page.busy = false;
      }
    }
    const accountEdit = reactive({ open: false, id: null, index: -1, entries: [], draft: emptySecret(), busy: false, error: '', showPw: false });
    watch(priv, (value) => { if (!value) { Object.assign(accountEdit, { open: false, entries: [], draft: emptySecret(), showPw: false }); page.secret = null; page.editing = false; } });
    const pageAccounts = computed(() => secretList(page.secret));
    const detailSections = [
      { key: 'summary', title: '简介', hint: '这个网站是什么、用来做什么' },
      { key: 'features', title: '功能亮点', hint: '每行一条' },
      { key: 'notes', title: '使用笔记', hint: '注意事项、技巧、收费情况等' },
      { key: 'links', title: '相关链接' },
    ];
    async function editAccount(index = -1) {
      if (page.loading || page.error) return;
      Object.assign(accountEdit, { open: true, id: page.id, index, showPw: false, entries: structuredClone(secretList(JSON.parse(JSON.stringify(page.secret)))), draft: { ...emptySecret(), ...(index >= 0 ? JSON.parse(JSON.stringify(pageAccounts.value[index])) : {}) }, busy: false, error: '' });
    }
    async function saveAccount(remove = false) {
      accountEdit.busy = true;
      accountEdit.error = '';
      try {
        const entries = [...accountEdit.entries];
        if (remove) entries.splice(accountEdit.index, 1);
        else if (accountEdit.index < 0) entries.push(accountEdit.draft);
        else entries[accountEdit.index] = accountEdit.draft;
        await api('PUT', `/links/${accountEdit.id}/secret`, { secret: entries });
        accountEdit.open = false;
        await loadData();
        say('账号信息已保存');
      } catch (e) { accountEdit.error = e.message; }
      finally { accountEdit.busy = false; }
    }
    async function copy(text) {
      await copyText(text);
      say('已复制');
    }

    // ---------- 网址增删改 ----------
    const form = reactive({ open: false, secret: emptySecret() });
    // 正在编辑的那个网址（新建时为空），图标那一行要用
    const formLink = computed(() => (form.id ? st.links.find((l) => l.id === form.id) : null));
    // 打开编辑弹窗时自动列出候选图标
    watch(() => form.open && form.id, (id) => id && loadIconChoices(st.links.find((l) => l.id === id)));
    const formCatPrivate = computed(
      () => form.categories?.length > 0 && form.categories.every((path) => catOrder.value.some(({ cat }) => catPath(cat.id) === path && catPrivate(cat.id)))
    );
    function addFormCat() {
      const name = form.catInput?.trim();
      if (name && !form.categories.includes(name)) form.categories.push(name);
      form.catInput = '';
    }

    async function editLink(link = null, preset = {}) {
      menuOpen.value = false;
      Object.assign(form, {
        open: true,
        id: link?.id ?? null,
        url: link?.url ?? '',
        title: link?.title ?? '',
        categories: link ? link.categories.map(catPath) : nav.type === 'cat' && nav.id !== null ? [catPath(nav.id)] : [],
        catInput: '',
        tags: link?.tags.join(' ') ?? '',
        desc: link?.desc ?? '',
        private: link ? link.private : prefs.newPrivate,
        pinned: link?.pinned ?? false,
        nsfw: link?.nsfw ?? false,
        secret: emptySecret(),
        // 已有账号信息要先取回来；没取到之前保存不会带上 secret，避免误清空
        secretReady: !link?.has_secret,
        secretOpen: !!link?.has_secret,
        showPw: false,
        error: '',
        busy: false,
        ...preset,
      });
    }

    function fixUrl() {
      if (form.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(form.url)) form.url = 'https://' + form.url;
    }
    async function saveLink() {
      fixUrl();
      addFormCat();
      form.busy = true;
      form.error = '';
      try {
        const body = {
          url: form.url,
          title: form.title,
          categories: form.categories,
          tags: form.tags,
          desc: form.desc,
          private: form.private,
          pinned: form.pinned,
          nsfw: form.nsfw,
        };
        await (form.id ? api('PUT', `/links/${form.id}`, body) : api('POST', '/links', body));
        if (!form.id) prefs.newPrivate = form.private;
        form.open = false;
        await loadData();
        say('已保存');
      } catch (e) {
        form.error = e.message;
      } finally {
        form.busy = false;
      }
    }
    // 既给编辑弹窗用（默认删表单里的那条），也给右键菜单用
    function removeLink(target = form) {
      confirmBox('删除网址', `确定删除「${target.title || target.url}」吗？保存的账号信息会一并删除。`, [
        {
          label: '删除',
          danger: true,
          async run() {
            await api('DELETE', `/links/${target.id}`);
            form.open = false;
            await loadData();
            say('已删除');
          },
        },
      ]);
    }
    async function patchLink(link, patch) {
      Object.assign(link, patch);
      const { id, secret, ...body } = link;
      try {
        await api('PUT', `/links/${id}`, body);
      } catch (e) {
        say(e.message);
      }
      await loadData();
    }
    async function copySecret(link, field, label) {
      try {
        const { secret } = await api('GET', `/links/${link.id}/secret`);
        const entries = secretList(secret);
        if (entries.length > 1) return (openDetail(link), say('请在详情页选择要复制的账号'));
        if (entries[0]?.[field]) await copy(entries[0][field]);
        else say(`没有保存${label}`);
      } catch (e) {
        say(e.message);
      }
    }

    // data-cat 属性：没有 = 来源不明，'' = 未分类，数字 = 分类 id
    const parseCat = (v) => (v === undefined ? undefined : v === '' ? null : Number(v));

    // 在主区域里拖卡片：同组内是排序，跨组是从原分类移出、移入新分类
    async function moveLink({ id, from, to, index }) {
      const link = st.links.find((l) => l.id === id);
      const toId = parseCat(to);
      const fromId = parseCat(from);
      const list = st.links
        .filter((l) => l.id !== id && (toId === null ? !l.categories.length : l.categories.includes(toId)))
        .sort(posIn(toId));
      list.splice(index, 0, link);
      const moved = fromId !== toId ? { id, from: fromId } : undefined;
      if (moved) {
        link.categories = link.categories.filter((c) => c !== fromId);
        if (toId !== null && !link.categories.includes(toId)) link.categories.push(toId);
      }
      list.forEach((l, i) => (toId === null ? (l.sort = i) : (l.pos[toId] = i)));
      await api('POST', '/reorder', { type: 'links', category_id: toId, ids: list.map((l) => l.id), moved }).catch((e) => say(e.message));
      if (moved) await loadData();
    }

    // 把卡片拖到侧栏的某个分类上
    const drag = ref(null);
    const dropCat = ref(undefined);
    function cardDragStart(e, link) {
      drag.value = { link, from: parseCat(e.target.closest('.grid')?.dataset.cat) };
    }
    function cardDragEnd() {
      drag.value = null;
      dropCat.value = undefined;
    }
    function catDragOver(e, catId) {
      if (!drag.value || !priv.value) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dropCat.value = catId;
    }
    // 把一个网址从 from 分类移到 catId 分类（null 表示未分类）。返回 'moved' / 'added' / 'none'
    async function moveOne(link, from, catId) {
      // 多选时，某些网址可能本来就不在拖出的那个分类里
      if (from != null && !link.categories.includes(from)) from = undefined;
      // 不知道来源（搜索结果、按名称排序这类平铺视图，或上面那种情况）：只属于一个分类就从那里移出
      if (from === undefined && link.categories.length <= 1) from = link.categories[0] ?? null;
      if (from === catId) return 'none';
      if (catId === null && from === undefined) {
        await api('PUT', `/links/${link.id}`, { ...link, categories: [] });
        return 'moved';
      }
      const ids = catId === null ? [] : st.links.filter((l) => l.id !== link.id && l.categories.includes(catId)).sort(posIn(catId)).map((l) => l.id);
      if (catId !== null) ids.push(link.id);
      await api('POST', '/reorder', { type: 'links', category_id: catId, ids, moved: { id: link.id, from: from ?? null } });
      return from === undefined ? 'added' : 'moved';
    }
    async function catDrop(e, catId) {
      if (!drag.value || !priv.value) return;
      e.preventDefault();
      dropHandled = true;
      const { link, from } = drag.value;
      cardDragEnd();
      // 拖的是多选中的一张：选中的全部一起移
      const batch = sel.has(link.id) && sel.size > 1;
      const list = batch ? selectedLinks() : [link];
      const target = catId === null ? '未分类' : `「${catLabel(catId)}」`;
      try {
        let result;
        for (const l of list) result = await moveOne(l, from, catId);
        await loadData();
        if (batch) {
          exitSel();
          say(`已把 ${list.length} 个网址移到${target}`);
        } else if (result === 'added') {
          say(`已加入${target}；它属于多个分类，原有分类保留`);
        } else if (result === 'moved') {
          const now = st.links.find((l) => l.id === link.id);
          say(catId === null && now.categories.length ? '已从该分类移出，它还在其他分类里' : `已移到${target}`);
        }
      } catch (err) {
        say(err.message);
        await loadData();
      }
    }

    // ---------- 多选 ----------
    // Ctrl / ⌘ + 点击卡片进入多选；多选中直接点击是勾选，Shift + 点击连选
    const sel = reactive(new Set());
    // 是否处于多选模式。和「选中了几个」分开记，这样取消全选后还留在多选里
    const selMode = ref(false);
    let lastSel = null;
    function exitSel() {
      sel.clear();
      selMode.value = false;
    }
    const selectedLinks = () => st.links.filter((l) => sel.has(l.id));
    function cardClick(e, l) {
      if (!priv.value || !(selMode.value || e.ctrlKey || e.metaKey || e.shiftKey)) return visit(l);
      e.preventDefault();
      selMode.value = true;
      const order = groups.value.flatMap((g) => g.links.map((x) => x.id));
      const a = order.indexOf(lastSel);
      const b = order.indexOf(l.id);
      if (e.shiftKey && a >= 0) {
        for (const id of order.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(id);
      } else if (sel.has(l.id)) {
        sel.delete(l.id);
      } else {
        sel.add(l.id);
      }
      lastSel = l.id;
    }
    // 全选 / 取消全选：作用于一组网址，都已选中时再点就是取消
    const allIn = (links) => links.length > 0 && links.every((l) => sel.has(l.id));
    function toggleLinks(links) {
      const off = allIn(links);
      for (const l of links) off ? sel.delete(l.id) : sel.add(l.id);
      selMode.value = true;
    }
    const allSelected = computed(() => allIn(shown.value));
    const toggleAll = () => toggleLinks(shown.value);
    // 对选中的每个网址应用同一个修改，做完退出多选
    async function batchPatch(patch, done) {
      const list = selectedLinks();
      try {
        for (const l of list) {
          const { id, secret, ...body } = { ...l, ...patch(l) };
          await api('PUT', `/links/${id}`, body);
        }
        say(`${done}（${list.length} 个）`);
        exitSel();
      } catch (e) {
        say(e.message);
      }
      await loadData();
    }
    function batchDelete() {
      const list = selectedLinks();
      confirmBox('删除网址', `确定删除选中的 ${list.length} 个网址吗？保存的账号信息会一并删除。`, [
        {
          label: `删除 ${list.length} 个`,
          danger: true,
          async run() {
            try {
              for (const l of list) await api('DELETE', `/links/${l.id}`);
              say(`已删除 ${list.length} 个`);
            } catch (e) {
              say(e.message);
            }
            exitSel();
            await loadData();
          },
        },
      ]);
    }
    const moveItems = () => [
      ...catOrder.value.map(({ cat, depth }) => ({ label: indent(depth, cat.name), run: () => batchPatch(() => ({ categories: [cat.id] }), `已移到「${catLabel(cat.id)}」`) })),
      st.categories.length ? SEP : null,
      { label: '未分类', run: () => batchPatch(() => ({ categories: [] }), '已移到未分类') },
    ];
    const addItems = () =>
      catOrder.value.map(({ cat, depth }) => ({
        label: indent(depth, cat.name),
        run: () => batchPatch((l) => ({ categories: [...new Set([...l.categories, cat.id])] }), `已加入「${catLabel(cat.id)}」`),
      }));
    const moreItems = () => [
      { label: '设为常用', icon: 'star', run: () => batchPatch(() => ({ pinned: true }), '已设为常用') },
      { label: '取消常用', run: () => batchPatch(() => ({ pinned: false }), '已取消常用') },
      { label: '标记为 NSFW', icon: 'nsfw', run: () => batchPatch(() => ({ nsfw: true }), '已标记为 NSFW') },
      { label: '取消 NSFW 标记', run: () => batchPatch(() => ({ nsfw: false }), '已取消 NSFW 标记') },
      SEP,
      { label: '设为私密', icon: 'lock', run: () => batchPatch(() => ({ private: true }), '已设为私密') },
      { label: '设为公开', icon: 'unlock', run: () => batchPatch(() => ({ private: false }), '已设为公开') },
      SEP,
      { label: '复制网址', icon: 'copy', run: () => copy(selectedLinks().map((l) => l.url).join('\n')) },
    ];
    // 底部操作条上的按钮：点开对应的小菜单
    function batchMenu(e, kind) {
      openCtx(e, { move: moveItems, add: addItems, more: moreItems }[kind](), e.currentTarget);
    }
    // 在选中的卡片上右键：所有批量操作合在一个菜单里
    function selMenu(e) {
      openCtx(e, [
        { label: '移动到', icon: 'folder', children: moveItems().filter(Boolean) },
        st.categories.length ? { label: '加入分类', icon: 'plus', children: addItems() } : null,
        SEP,
        ...moreItems(),
        SEP,
        { label: allSelected.value ? '取消全选' : '全选当前列表', icon: 'check', run: toggleAll },
        { label: '退出多选', icon: 'x', run: exitSel },
        { label: `删除 ${sel.size} 个`, icon: 'trash', danger: true, run: batchDelete },
      ]);
    }

    const canDrag = computed(
      () => priv.value && sort.value === 'custom' && !query.value && !tag.value && vis.value === 'all' && ['all', 'cat'].includes(nav.type)
    );

    // ---------- 分类 ----------
    const catForm = reactive({ open: false });
    function editCat(cat = null, preset = {}) {
      Object.assign(catForm, {
        open: true,
        id: cat?.id ?? null,
        name: cat?.name ?? '',
        private: cat?.private ?? false,
        nsfw: cat?.nsfw ?? false,
        // 下拉框里用空串表示顶层
        parent: cat?.parent_id ?? preset.parent ?? '',
        error: '',
      });
    }
    // 可以当上级的分类：不能是自己或自己的子分类，放进去之后也不能超过三层
    function parentChoices(catId) {
      const own = catId == null ? [] : subtreeIds(catId);
      const height = catId == null ? 1 : catHeight(catId);
      return catOrder.value.filter(({ cat }) => !own.includes(cat.id) && catDepth(cat.id) + height <= MAX_DEPTH);
    }
    async function saveCat() {
      try {
        const body = { name: catForm.name, private: catForm.private, nsfw: catForm.nsfw, parent_id: catForm.parent === '' ? null : Number(catForm.parent) };
        await (catForm.id ? api('PUT', `/categories/${catForm.id}`, body) : api('POST', '/categories', body));
        catForm.open = false;
        // 新建的子分类要看得见，把它的上级展开
        if (body.parent_id != null) delete prefs.sideFolded[body.parent_id];
        await loadData();
      } catch (e) {
        catForm.error = e.message;
      }
    }
    function removeCat(target = catForm) {
      const count = catCount.value[target.id] || 0;
      const kids = kidsOf(target.id).length;
      const run = (withLinks) => async () => {
        await api('DELETE', `/categories/${target.id}`, { with_links: withLinks });
        catForm.open = false;
        await loadData();
        say('已删除');
      };
      confirmBox(
        '删除分类',
        count || kids
          ? `「${target.name}」${kids ? '连同它的子分类' : ''}里有 ${count} 个网址。只删除这个分类的话，里面的网址${kids ? '和子分类' : ''}会上移一层${
              target.parent_id == null && !kids ? '（变成未分类）' : ''
            }。`
          : `确定删除「${target.name}」吗？`,
        count || kids
          ? [{ label: kids ? '整个分类连同网址删除' : '连同网址删除', danger: true, run: run(true) }, { label: '只删除这个分类', run: run(false) }]
          : [{ label: '删除', danger: true, run: run(false) }]
      );
    }
    async function patchCat(cat, patch) {
      try {
        await api('PUT', `/categories/${cat.id}`, { name: cat.name, private: cat.private, ...patch });
      } catch (e) {
        say(e.message);
      }
      await loadData();
    }

    // ---------- 右键菜单 ----------
    // 只在管理员模式接管右键；公开模式和 Shift+右键保留浏览器自带菜单
    const ctx = reactive({ open: false, x: 0, y: 0, flip: false, up: false, sub: null, at: 0, items: [] });
    // 以触摸为主的设备：提示文案用「长按」，菜单以底部面板呈现
    const coarse = matchMedia('(pointer: coarse)');
    const isTouch = ref(coarse.matches);
    coarse.addEventListener('change', (e) => (isTouch.value = e.matches));
    const ctxEl = ref(null);
    // anchor：传入按钮元素时，菜单贴着按钮上方弹出，而不是跟着鼠标位置
    function openCtx(e, items, anchor = null) {
      e.preventDefault();
      e.stopPropagation();
      menuOpen.value = false;
      Object.assign(ctx, { open: true, x: e.clientX, y: e.clientY, flip: false, up: false, sub: null, at: Date.now(), items: items.filter(Boolean) });
      // 渲染后再量尺寸，贴边时往回收，子菜单放不下就朝另一侧展开
      nextTick(() => {
        const r = ctxEl.value.getBoundingClientRect();
        if (anchor) {
          const a = anchor.getBoundingClientRect();
          ctx.x = a.left;
          ctx.y = a.top - r.height - 6;
        }
        ctx.x = Math.max(6, Math.min(ctx.x, innerWidth - r.width - 6));
        ctx.y = Math.max(6, Math.min(ctx.y, innerHeight - r.height - 6));
        ctx.flip = ctx.x + r.width * 2 > innerWidth;
        ctx.up = ctx.y > innerHeight * 0.5;
      });
    }
    function runCtx(item, index) {
      // 带子菜单的项：桌面靠悬停展开，触屏靠点击展开/收起
      if (item.children) return (ctx.sub = ctx.sub === index ? null : index);
      ctx.open = false;
      item.run();
    }
    const SEP = { sep: true };

    function linkMenu(e, l) {
      if (e.shiftKey) return;
      const open = (target) => {
        visit(l);
        window.open(l.url, target, 'noopener,noreferrer');
      };
      // 公开模式只有查看类的操作
      if (!priv.value) {
        return openCtx(e, [
          { label: '查看详情', icon: 'info', run: () => openDetail(l) },
          SEP,
          { label: '新标签页打开', icon: 'external', run: () => open('_blank') },
          { label: '复制网址', icon: 'copy', run: () => copy(l.url) },
        ]);
      }
      if (sel.has(l.id)) return selMenu(e);
      openCtx(e, [
        { label: '查看详情', icon: 'info', run: () => openDetail(l) },
        { label: '编辑', icon: 'edit', run: () => editLink(l) },
        SEP,
        { label: '新标签页打开', icon: 'external', run: () => open('_blank') },
        { label: '当前页打开', run: () => open('_self') },
        { label: '复制网址', icon: 'copy', run: () => copy(l.url) },
        SEP,
        { label: l.pinned ? '取消常用' : '设为常用', icon: 'star', run: () => patchLink(l, { pinned: !l.pinned }) },
        { label: l.nsfw ? '取消 NSFW 标记' : '标记为 NSFW', icon: 'nsfw', run: () => patchLink(l, { nsfw: !l.nsfw }) },
        {
          label: l.private ? '设为公开' : '设为私密',
          icon: l.private ? 'unlock' : 'lock',
          async run() {
            await patchLink(l, { private: !l.private });
            if (!l.private && isPrivate(l)) say('它所属的分类都是私密的，这个网址仍然不会公开');
          },
        },
        {
          label: '所属分类',
          icon: 'folder',
          // 勾选即加入、再点即移出，可以同时属于多个分类
          children: [
            ...catOrder.value.map(({ cat, depth }) => ({
              label: indent(depth, cat.name),
              checked: l.categories.includes(cat.id),
              run: () =>
                patchLink(l, {
                  categories: l.categories.includes(cat.id) ? l.categories.filter((id) => id !== cat.id) : [...l.categories, cat.id],
                }),
            })),
            st.categories.length ? SEP : null,
            { label: '未分类', checked: !l.categories.length, run: () => patchLink(l, { categories: [] }) },
          ].filter(Boolean),
        },
        SEP,
        { label: '多选', icon: 'check', run: () => (sel.add(l.id), (lastSel = l.id), (selMode.value = true)) },
        { label: '删除', icon: 'trash', danger: true, run: () => removeLink(l) },
      ]);
    }

    function catMenu(e, c) {
      if (!priv.value || e.shiftKey || !c) return;
      const moveTo = (parentId) => async () => {
        await patchCat(c, { parent_id: parentId });
        if (parentId != null) delete prefs.sideFolded[parentId];
      };
      const kids = kidsOf(c.id).length;
      openCtx(e, [
        { label: '在此分类添加网址', icon: 'plus', run: () => editLink(null, { categories: [catPath(c.id)] }) },
        catDepth(c.id) < MAX_DEPTH ? { label: '新建子分类', icon: 'folder', run: () => editCat(null, { parent: c.id }) } : null,
        {
          label: '全选此分类的网址',
          icon: 'check',
          // 先切到这个分类再选，保证选中的都看得见；子分类里的也算
          run() {
            go('cat', c.id);
            const ids = new Set(subtreeIds(c.id));
            toggleLinks(st.links.filter((l) => l.categories.some((id) => ids.has(id))));
          },
        },
        SEP,
        { label: '重命名 / 编辑', icon: 'edit', run: () => editCat(c) },
        {
          label: '移动到',
          icon: 'external',
          children: [
            { label: '顶层', checked: c.parent_id == null, run: moveTo(null) },
            SEP,
            ...parentChoices(c.id).map(({ cat, depth }) => ({ label: indent(depth, cat.name), checked: cat.id === c.parent_id, run: moveTo(cat.id) })),
          ],
        },
        {
          label: c.private ? '设为公开分类' : '设为私密分类',
          icon: c.private ? 'unlock' : 'lock',
          run: () => patchCat(c, { private: !c.private }),
        },
        {
          label: c.nsfw ? '取消 NSFW 标记' : '标记为 NSFW 分类',
          icon: 'nsfw',
          run: () => patchCat(c, { nsfw: !c.nsfw }),
        },
        kids ? { label: prefs.sideFolded[c.id] ? '展开子分类' : '收起子分类', icon: 'chevron', run: () => toggleSideFold(c.id) } : null,
        SEP,
        { label: '删除分类', icon: 'trash', danger: true, run: () => removeCat(c) },
      ]);
    }

    function blankMenu(e) {
      if (!priv.value || e.shiftKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      openCtx(e, [
        { label: '添加网址', icon: 'plus', run: () => editLink() },
        { label: '新建分类', icon: 'folder', run: () => editCat() },
        { label: '导入书签', icon: 'upload', run: () => openImport() },
        SEP,
        { label: '刷新', icon: 'refresh', run: () => location.reload() },
        SEP,
        {
          label: prefs.view === 'card' ? '切换为列表' : '切换为卡片',
          icon: prefs.view === 'card' ? 'list' : 'grid',
          run: () => (prefs.view = prefs.view === 'card' ? 'list' : 'card'),
        },
        { label: '收起全部分类', icon: 'chevron', run: () => foldAll(true) },
        { label: '展开全部分类', run: () => foldAll(false) },
        SEP,
        { label: '切到公开模式', icon: 'lock', run: toggleMode },
        { label: '设置', icon: 'settings', run: () => openSettings() },
      ]);
    }
    // 侧栏里拖动分类：只调整它在同级里的先后。换上级用右键菜单的「移动到」
    async function moveCat({ id, index }) {
      const me = catById.value.get(id);
      const flat = sideCats.value.map((row) => row.cat).filter((c) => c.id !== id);
      flat.splice(index, 0, me);
      const siblings = flat.filter((c) => (c.parent_id ?? null) === (me.parent_id ?? null));
      siblings.forEach((c, i) => (c.sort = i));
      await api('POST', '/reorder', { type: 'categories', ids: siblings.map((c) => c.id) }).catch((e) => say(e.message));
    }

    // ---------- 导入 ----------
    const imp = reactive({ open: false, items: [], folders: [], cats: [], file: '', private: true, over: false, error: '', busy: false });
    const impCount = computed(() => {
      const on = new Set(imp.folders.filter((f) => f.on).map((f) => f.name));
      return imp.items.filter((i) => on.has(i.category)).length;
    });
    function openImport() {
      menuOpen.value = false;
      Object.assign(imp, { open: true, items: [], folders: [], cats: [], error: '', busy: false, over: false });
    }
    async function readFile(file) {
      imp.error = '';
      if (!file) return;
      let items;
      let cats = [];
      const isBackup = /\.json$/i.test(file.name);
      try {
        const text = await file.text();
        if (isBackup) {
          const data = JSON.parse(text);
          // 预览按第一个分类归组；提交时服务端用的是完整的 categories
          items = data.links.map((l) => ({ ...l, category: l.categories?.[0] ?? l.category ?? '' }));
          cats = data.categories || [];
        } else {
          items = parseBookmarks(text);
        }
      } catch {
        imp.error = '无法解析这个文件，请确认是书签 .html 或备份 .json。';
        return;
      }
      if (!items.length) {
        imp.error = '文件里没有找到网址。';
        return;
      }
      const count = Map.groupBy(items, (i) => i.category);
      Object.assign(imp, {
        items,
        cats,
        file: file.name,
        // 备份文件自带公开/私密标记，默认照原样恢复
        private: !isBackup,
        folders: [...count].map(([name, list]) => ({ name, count: list.length, on: true })),
      });
    }
    function onDrop(e) {
      imp.over = false;
      readFile(e.dataTransfer.files[0]);
    }
    function toggleAllFolders() {
      const on = !imp.folders.every((f) => f.on);
      imp.folders.forEach((f) => (f.on = on));
    }
    async function doImport() {
      imp.busy = true;
      imp.error = '';
      try {
        const on = new Set(imp.folders.filter((f) => f.on).map((f) => f.name));
        const result = await api('POST', '/import', {
          items: imp.items.filter((i) => on.has(i.category)),
          categories: imp.cats,
          private: imp.private,
        });
        imp.open = false;
        await loadData();
        say(`已导入 ${result.added} 个` + (result.skipped ? `，跳过 ${result.skipped} 个重复或无效的` : ''));
      } catch (e) {
        imp.error = e.message;
      } finally {
        imp.busy = false;
      }
    }

    // ---------- 从浏览器拖入 ----------
    const dropping = ref(false);
    let ownDrag = false;
    let dropTimer;
    // 页面内部的拖拽（卡片排序）会触发 dragstart，浏览器外面拖进来的不会
    document.addEventListener('dragstart', () => {
      ownDrag = true;
      dropHandled = false;
    });
    // 卡片换分类后原节点会被移除，收不到 dragend，所以松手时也要复位
    document.addEventListener('drop', () => setTimeout(() => (ownDrag = false)), true);
    document.addEventListener('dragend', () => (ownDrag = false));
    const fromOutside = (e) => !ownDrag && !modals.some((m) => m.open) && st.setup && e.dataTransfer?.types.length;

    document.addEventListener('dragover', (e) => {
      if (!fromOutside(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropping.value = true;
      clearTimeout(dropTimer);
      dropTimer = setTimeout(() => (dropping.value = false), 200);
    });
    document.addEventListener('drop', (e) => {
      if (!fromOutside(e)) return;
      e.preventDefault();
      dropping.value = false;
      // dataTransfer 只在事件处理期间可读，先同步取出来
      const file = e.dataTransfer.files[0];
      const items = file ? [] : readDrop(e.dataTransfer);
      // 落在某个分类（侧栏或分组）上就加到那个分类，否则加到当前正在看的分类
      const grid = e.target.closest?.('.grid[data-cat]');
      const side = e.target.closest?.('.cats [data-id]');
      const catId = side ? Number(side.dataset.id) : grid?.dataset.cat ? Number(grid.dataset.cat) : nav.type === 'cat' ? nav.id : null;
      const run = () => (file ? (openImport(), readFile(file)) : addDropped(items, catPath(catId)));
      if (priv.value) run();
      else if (st.authorized) toggleMode().then(run);
      else askLogin(run);
    });

    // 在书签管理器里多选后 Ctrl+C，回到这里 Ctrl+V，也能一次加进来
    document.addEventListener('paste', (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || modals.some((m) => m.open) || !st.setup) return;
      const items = readDrop(e.clipboardData);
      if (!items.length) return;
      e.preventDefault();
      const run = () => addDropped(items, nav.type === 'cat' ? catPath(nav.id) : '');
      if (priv.value) run();
      else if (st.authorized) toggleMode().then(run);
      else askLogin(run);
    });

    async function addDropped(items, category) {
      if (!items.length) {
        say('没有读到网址。浏览器不让网页读取拖入的书签文件夹时，请改用「导入书签」');
        return;
      }
      items.forEach((item) => (item.category ||= category));
      if (items.length > 1) {
        // 一次拖进来多个：先给预览，确认后再导入
        const count = Map.groupBy(items, (i) => i.category);
        Object.assign(imp, {
          open: true, items, cats: [], file: '拖入的内容', private: prefs.newPrivate, over: false, error: '', busy: false,
          folders: [...count].map(([name, list]) => ({ name, count: list.length, on: true })),
        });
        return;
      }
      try {
        say('正在添加…');
        const result = await api('POST', '/import', { items, private: prefs.newPrivate });
        await loadData();
        const added = st.links.at(-1);
        say(result.added ? `已添加「${added.title}」` + (category ? `到「${category.replaceAll('/', ' / ')}」` : '') : '这个网址已经在导航里了');
      } catch (e) {
        say(e.message);
      }
    }

    // ---------- 设置 ----------
    const set = reactive({ open: false, tab: 'look' });
    function openSettings(tab = 'look') {
      menuOpen.value = false;
      Object.assign(set, {
        open: true,
        tab: priv.value ? tab : 'look',
        title: st.title,
        logoMode: st.logo.startsWith('data:') ? 'image' : st.logo ? 'text' : 'default',
        logoText: st.logo.startsWith('data:') ? '' : st.logo,
        logoImage: st.logo.startsWith('data:') ? st.logo : '',
        search: st.settings.search,
        whitelist: (st.settings.whitelist || []).join('\n'),
        newPassword: '',
        newPassword2: '',
        currentPassword: '',
        withSecrets: false,
        agentPrivate: !!st.settings.agent?.private,
        agentWebhook: st.settings.agent?.webhook || '',
        srvPort: st.settings.server?.port,
        srvHost: st.settings.server?.host,
        srvProxy: st.settings.server?.trustProxy,
        srvOutProxy: st.settings.server?.proxy,
        srvIconService: st.settings.server?.iconService || 'public',
        srvPublicUrl: st.settings.server?.publicUrl,
        srvDays: st.settings.server?.sessionDays,
        token: '',
        error: '',
      });
    }
    watch(() => set.tab, () => (set.error = ''));
    async function saveSettings(body) {
      set.error = '';
      try {
        await api('PUT', '/settings', body);
        await load();
        openSettings(set.tab);
        say('已保存');
      } catch (e) {
        set.error = e.message;
      }
    }
    // ---------- 服务器设置 ----------
    async function saveServer() {
      set.error = '';
      const direct = String(st.settings.server.port) === (location.port || (location.protocol === 'https:' ? '443' : '80'));
      try {
        const res = await api('PUT', '/server', {
          current_password: set.currentPassword,
          port: Number(set.srvPort),
          host: set.srvHost,
          trust_proxy: set.srvProxy,
          proxy: set.srvOutProxy,
          icon_service: set.srvIconService,
          public_url: set.srvPublicUrl,
          session_days: Number(set.srvDays),
        });
        if (res.moved && direct) {
          // 直接用端口访问的：服务换了端口，带用户过去
          say('监听地址已更改，正在跳转…');
          setTimeout(() => (location.href = `${location.protocol}//${location.hostname}:${res.port}/`), 1200);
          return;
        }
        await load();
        openSettings('server');
        say(res.moved ? '已保存。别忘了同步修改反向代理或端口映射' : '已保存');
      } catch (e) {
        set.error = e.message;
      }
    }
    // 对外地址：填了就用它，没填用当前浏览器地址栏里的
    const origin = computed(() => st.settings.server?.publicUrl || location.origin);

    // 智能体接入：生成 / 停用令牌，或只保存选项。令牌只在生成后显示这一次
    async function agentSave(action) {
      set.error = '';
      try {
        const res = await api('PUT', '/settings', {
          current_password: set.currentPassword,
          agent_private: set.agentPrivate,
          agent_webhook: set.agentWebhook,
          ...(action && { agent_action: action }),
        });
        await loadData();
        set.token = res.token || '';
        set.currentPassword = '';
        say(action === 'generate' ? '已生成新令牌' : action === 'revoke' ? '已停用智能体接入' : '已保存');
      } catch (e) {
        set.error = e.message;
      }
    }
    const agentPrompt = computed(
      () => `你可以通过 HTTP 接口维护我的网址导航里每个网址的「详情」。

基础地址：${origin.value}/api/agent
所有请求都带请求头：Authorization: Bearer ${set.token || '<在这里填入令牌>'}

步骤：
1. GET /links?missing=1 列出还没有详情的网址（去掉 missing 则列出全部）。
2. 逐个打开网址，弄清它是什么、能做什么。
3. PUT /links/{id}/detail 写入详情，请求体为 JSON：
   {
     "summary": "简介，1~3 句",
     "features": ["功能亮点，每条一句"],
     "notes": "使用笔记：注意事项、技巧、收费情况等",
     "links": [{ "label": "文档", "url": "https://…" }],
     "desc": "（可选）卡片上的一句话描述",
     "tags": ["（可选）标签"]
   }

GET /schema 可以取到完整的字段说明。打不开或看不懂的网址请跳过，不要编造内容。`
    );
    // ---------- 站点图标 ----------
    // 设置里的 logo 有三种：'' 默认首字、data URL 图片、其余当作自定义文字
    const logoIsImage = computed(() => st.logo.startsWith('data:'));
    const logoText = computed(() => (logoIsImage.value ? '' : st.logo || st.title.slice(0, 1)));
    // 文字越多字号越小，保证四个字符也放得进小方块
    const logoScale = (text) => [1, 1, 0.82, 0.62, 0.5][[...text].length] || 0.5;
    const setLogoValue = () => (set.logoMode === 'image' ? set.logoImage : set.logoMode === 'text' ? set.logoText.trim() : '');
    const saveSite = () => {
      if (set.logoMode === 'image' && !set.logoImage) return (set.error = '请先选择一张图片，或改用其他图标方式');
      saveSettings({ title: set.title, search: set.search, logo: setLogoValue() });
    };

    // 标签页图标：图片直接用；文字的话画一张同款的小图
    function applyFavicon() {
      let href = st.logo;
      if (!logoIsImage.value) {
        const size = 64;
        const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
        const c = canvas.getContext('2d');
        c.fillStyle = prefs.accent;
        c.beginPath();
        c.roundRect(0, 0, size, size, 18);
        c.fill();
        c.fillStyle = '#fff';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `${Math.round(38 * logoScale(logoText.value))}px "975Maru SC", system-ui, sans-serif`;
        c.fillText(logoText.value, size / 2, size / 2 + 2);
        href = canvas.toDataURL('image/png');
      }
      const icon = document.querySelector('link[rel=icon]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
      icon.href = href;
    }
    watch([() => st.logo, () => st.title, () => prefs.accent], applyFavicon);
    document.fonts.ready.then(applyFavicon);

    // 选图 → （HEIC 先转码）→ 打开裁切窗口。裁切库和 HEIC 解码库都比较大，用到时才加载
    const crop = reactive({ open: false, src: '', busy: false, error: '', link: null });
    const cropImg = ref(null);
    let cropper = null;
    async function pickLogo(file, link = null) {
      if (!file) return;
      set.error = '';
      crop.link = link;
      crop.busy = true;
      try {
        let blob = file;
        if (/\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type)) {
          say('正在转换 HEIC 图片…');
          const { heicTo } = await import('/vendor/heic.js');
          blob = await heicTo({ blob: file, type: 'image/png' });
        }
        // 先确认浏览器能解码，免得打开一个空白的裁切窗口
        (await createImageBitmap(blob)).close();
        if (crop.src) URL.revokeObjectURL(crop.src);
        crop.src = URL.createObjectURL(blob);
        openCrop();
      } catch {
        if (link) say('这个文件不是能识别的图片');
        else set.error = '这个文件不是能识别的图片';
      } finally {
        crop.busy = false;
      }
    }
    function openCrop() {
      crop.error = '';
      crop.open = true;
    }
    async function initCropper() {
      if (!document.querySelector('link[data-cropper]')) {
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/cropper.css' });
        link.dataset.cropper = '1';
        document.head.append(link);
      }
      const { default: Cropper } = await import('/vendor/cropper.js');
      cropper?.destroy();
      // 裁切框固定为正方形，移动和缩放的是下面的图片（和设置头像时的操作一样）
      cropper = new Cropper(cropImg.value, {
        aspectRatio: 1,
        viewMode: 0,
        dragMode: 'move',
        autoCropArea: 0.86,
        cropBoxMovable: false,
        cropBoxResizable: false,
        guides: false,
        center: false,
        toggleDragModeOnDblclick: false,
      });
    }
    const cropDo = (action, value) => cropper?.[action](value);
    function closeCrop() {
      cropper?.destroy();
      cropper = null;
      crop.open = false;
    }
    function confirmCrop() {
      if (!cropper) return;
      const canvas = cropper.getCroppedCanvas({ width: 256, height: 256, imageSmoothingQuality: 'high' });
      // 优先 PNG（保留透明）；照片类图片 PNG 会很大，超出上限就换成 WebP
      let data = canvas.toDataURL('image/png');
      if (data.length > 280000) data = canvas.toDataURL('image/webp', 0.9);
      if (data.length > 280000) return (crop.error = '这张图细节太多，压缩后仍然过大，请换一张简单些的');
      if (crop.link) {
        // 给某个网址换图标：直接保存，用完把图丢掉（设置里的「重新裁切」只对站点图标有意义）
        const link = crop.link;
        closeCrop();
        URL.revokeObjectURL(crop.src);
        Object.assign(crop, { src: '', link: null });
        setIcon(link, data);
        iconPick.chosen = -1;
        return;
      }
      set.logoImage = data;
      set.logoMode = 'image';
      closeCrop();
    }
    // 白名单和改密码各有各的保存按钮，互不牵连
    const saveWhitelist = () =>
      saveSettings({ current_password: set.currentPassword, whitelist: set.whitelist.split(/\s+/).filter(Boolean) });
    const changePassword = () => {
      if (set.newPassword !== set.newPassword2) return (set.error = '两次输入的新密码不一致');
      saveSettings({ current_password: set.currentPassword, new_password: set.newPassword });
    };
    function addMyIp() {
      if (!set.whitelist.split(/\s+/).includes(st.ip)) set.whitelist = (set.whitelist.trim() + '\n' + st.ip).trim();
    }
    async function exportData(format) {
      try {
        const res = await request('GET', `/export?format=${format}` + (format === 'json' && set.withSecrets ? '&secrets=1' : ''));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await res.blob());
        a.download = `nav-${format === 'html' ? 'bookmarks' : 'backup'}-${new Date().toISOString().slice(0, 10)}.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        say(e.message);
      }
    }
    const bookmarklet = computed(
      () =>
        `javascript:void(open('${origin.value}/?add='+encodeURIComponent(location.href)` +
        `+'&title='+encodeURIComponent(document.title)))`
    );

    // ---------- 快捷键 ----------
    const help = reactive({ open: false });
    const modals = [accountEdit, ask, help, crop, login, form, catForm, imp, set];
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      const open = modals.find((m) => m.open);
      if (e.key === 'Escape') {
        if (ctx.open) return (ctx.open = false);
        if (open === crop) closeCrop();
        else if (open) open.open = false;
        else if (selMode.value) exitSel();
        else if (page.editing) page.editing = false;
        else if (pageLink.value) closePage();
        menuOpen.value = false;
      } else if (open) {
        return;
      } else if (selMode.value && !typing && e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleAll();
      } else if (sel.size && !typing && e.key === 'Delete') {
        batchDelete();
      } else if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchEl.value.focus();
        searchEl.value.select();
      } else if (e.key === 'n' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && priv.value) {
        e.preventDefault();
        editLink();
      }
    });
    const closeMenus = () => {
      menuOpen.value = false;
      // 长按刚弹出菜单时，松手带来的那次点击不算
      if (Date.now() - ctx.at > 500) ctx.open = false;
    };
    document.addEventListener('click', closeMenus);
    document.addEventListener('contextmenu', () => (ctx.open = false));
    document.addEventListener('scroll', (e) => ctxEl.value?.contains(e.target) || (ctx.open = false), true);
    window.addEventListener('blur', () => (ctx.open = false));
    window.addEventListener('resize', () => (ctx.open = false));

    // ---------- 启动 ----------
    // 等首次数据和字体都就绪再显示页面；字体最多等 0.8 秒，慢网下不至于一直空白
    load().then(async () => {
      await nextTick();
      // 先让浏览器排一次版，它才知道要用到哪些字体分片
      void document.body.offsetHeight;
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 800))]);
      readHash();
      document.documentElement.classList.add('ready');
      // 书签栏「收藏到导航」按钮带过来的网址
      const params = new URLSearchParams(location.search);
      const url = params.get('add');
      if (!url) return;
      history.replaceState(null, '', location.pathname);
      const open = () => editLink(null, { url, title: params.get('title') || '' });
      if (priv.value) open();
      else if (st.authorized) toggleMode().then(open);
      else if (st.setup) askLogin(open);
    });

    return {
      prefs, accents, isDark, toggleTheme, st, priv, toast, load,
      nav, query, tag, tagsOpen, vis, sort, menuOpen, searchEl,
      catCount, pinnedCount, recentCount, tagList, shown, groups, heading, go, resetFilters,
      catById, kidsOf, catPath, catLabel, catPrivate, catOrder, hasNested, sideCats, toggleSideFold, toggleFold, indent, parentChoices,
      visit, searchEnter, iconOk, iconSrc, iconShow, iconLoaded, iconFailed, host, color, isPrivate,
      login, toggleMode, toggleWork, NSFW_MODES, catNsfw, isNsfw, cardTip, doLogin, doSetup, ask,
      accountEdit, pageAccounts, detailSections, formLink, secBlur, secCancel, iconPick, loadIconChoices, chooseIcon, editAccount, saveAccount, emptySecret, uploadIcon, setIcon, refetchIcon, page, pageLink, openDetail, closePage, fmtTime, startEdit, saveDetail, copy, agentSave, agentPrompt,
      form, formCatPrivate, editLink, fixUrl, saveLink, removeLink, moveLink, canDrag, addFormCat,
      drag, dropCat, cardDragStart, cardDragEnd, catDragOver, catDrop,
      sel, selMode, exitSel, cardClick, allIn, toggleLinks, allSelected, toggleAll, batchDelete, batchMenu,
      ctx, ctxEl, runCtx, linkMenu, catMenu, blankMenu, isTouch,
      catForm, editCat, saveCat, removeCat, moveCat,
      dropping, imp, impCount, openImport, readFile, onDrop, toggleAllFolders, doImport,
      help, set, openSettings, pickLogo, saveServer, saveSite, logoIsImage, logoText, logoScale,
      crop, cropImg, openCrop, initCropper, cropDo, closeCrop, confirmCrop, saveWhitelist, changePassword, addMyIp, exportData, bookmarklet,
    };
  },
})
  .component('modal', Modal)
  .component('pw-input', PwInput)
  .directive('sortable', vSortable)
  .directive('hold', vHold)
  .directive('focus', { mounted: (el) => el.focus() })
  .mount('#app');
