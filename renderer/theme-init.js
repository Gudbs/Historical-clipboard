/**
 * 主题预置：在 <head> 里同步执行。
 *
 * 为什么单独一个文件？
 *   preload 执行时 <html> 元素可能还没解析出来，直接写 document.documentElement 会抛错，
 *   而 preload 一旦抛错就暴露不出 window.clipHistory，整个界面会白屏。
 *   放到这里执行时 <html> 一定已存在，而且页面还没开始绘制，深色模式启动不会闪白。
 *
 * 这里出错也无所谓：读不到就用 index.html 上的默认值（浅色），app.js 随后还会再同步一次。
 */
(function () {
  try {
    var theme = window.clipHistory && window.clipHistory.getThemeSync
      ? window.clipHistory.getThemeSync()
      : 'light';
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  } catch (e) {
    /* 保持 index.html 上的默认浅色 */
  }
})();
