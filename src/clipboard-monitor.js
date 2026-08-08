/**
 * 剪贴板监听器：主进程内定时轮询系统剪贴板。
 *
 * 为什么用轮询而不是原生事件监听？
 *   - 原生剪贴板监听模块需要 node-gyp / VS Build Tools 编译，小白用户装不了；
 *   - 用 Electron 自带的 clipboard 模块每 800ms 轮询一次，CPU 占用极低，零编译。
 *
 * 每轮识别剪贴板内容类型（优先级：文件 > 图片 > 文本），交给 store 去重入库。
 */
const { clipboard } = require('electron');
const crypto = require('crypto');

const POLL_INTERVAL = 800; // 轮询间隔（毫秒）
let timer = null;

/** 启动轮询（main.js 调用一次） */
function start(store) {
  if (timer) return;
  timer = setInterval(() => poll(store), POLL_INTERVAL);
}

/** 停止轮询 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 单轮轮询 */
function poll(store) {
  try {
    const formats = clipboard.availableFormats();
    if (!formats || formats.length === 0) return;

    // 1) 文件复制（资源管理器里 Ctrl+C 复制文件）
    if (formats.includes('FileNameW') || formats.includes('FileName')) {
      const bufW = clipboard.readBuffer('FileNameW');
      if (bufW && bufW.length > 0) {
        const names = parseFileNames(bufW);
        const fileBufJson = JSON.stringify({
          FileNameW: bufW.toString('base64'),
          FileName: clipboard.readBuffer('FileName').toString('base64'),
          DropEffect: clipboard.readBuffer('Preferred DropEffect').toString('base64')
        });
        store.onCaptured({
          type: 'files',
          hash: sha256(bufW),
          content: names.join('\n'),          // 兜底复制时用
          fileBufJson,
          fileNames: JSON.stringify(names)     // 卡片显示用
        });
        return;
      }
    }

    // 2) 图片（截图 / 网页图片等）
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      store.onCaptured({
        type: 'image',
        hash: sha256(img.toBitmap()),         // 像素级指纹，同一图片稳定去重
        image: img
      });
      return;
    }

    // 3) 文本（过滤空白 / 无意义内容）
    const text = clipboard.readText();
    if (text && text.trim().length > 0) {
      store.onCaptured({
        type: 'text',
        hash: sha256(text),
        content: text
      });
    }
  } catch (e) {
    // 个别特殊剪贴板内容可能读取失败，忽略即可，不影响下一轮
  }
}

/** 解析 FileNameW（UTF-16LE，空字符分隔）中的文件路径列表 */
function parseFileNames(buf) {
  try {
    return buf.toString('utf16le').split('\0').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** sha256 指纹 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { start, stop };
