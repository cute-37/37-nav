// 在页面第一次绘制之前就把主题、密度、强调色设好，避免刷新时先闪一下亮色默认样式。
// 这是普通脚本（不是 module），放在 <head> 里会阻塞渲染，所以要保持很小。
(function () {
  var prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem('nav.prefs')) || {};
  } catch (e) {}
  var root = document.documentElement;
  var dark = prefs.theme === 'dark' || ((prefs.theme || 'auto') === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = prefs.density || 'cozy';
  if (prefs.accent) root.style.setProperty('--ac', prefs.accent);
  // 兜底：主脚本万一出错，也不要让页面一直空白
  setTimeout(function () {
    root.classList.add('ready');
  }, 4000);
})();
