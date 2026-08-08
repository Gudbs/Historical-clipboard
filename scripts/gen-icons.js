/**
 * 生成应用图标与托盘图标（纯 Node 内置模块，无需任何依赖）
 * 运行方式：node scripts/gen-icons.js
 * 输出：
 *   build/icon.png       256x256 应用 / 安装包图标
 *   build/tray-icon.png  32x32   Windows 系统托盘图标
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 编码基础 ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 把 RGBA 像素数组编码为 PNG 文件字节 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // 每行前导滤波字节 0
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制 ---------- */

/** 判断点是否在圆角矩形内 */
function inRoundRect(x, y, rx, ry, rw, rh, rad) {
  const cx = Math.max(rx + rad, Math.min(x, rx + rw - rad));
  const cy = Math.max(ry + rad, Math.min(y, ry + rh - rad));
  return Math.hypot(x - cx, y - cy) <= rad;
}

/**
 * 绘制剪贴板图标：
 * 蓝色圆形渐变背景 + 白色剪贴板（圆角矩形 + 顶部夹子 + 两条横线）
 */
function makeIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const bgR = size * 0.50;            // 背景圆半径
  const boardW = size * 0.52;         // 剪贴板宽度
  const boardH = size * 0.56;         // 剪贴板高度
  const boardX = cx - boardW / 2;
  const boardTop = size * 0.20;
  const boardBottom = boardTop + boardH;
  const radius = boardW * 0.16;       // 剪贴板圆角
  const clipH = size * 0.16;          // 顶部夹子高度
  const lineY1 = size * 0.50;         // 横线 1
  const lineY2 = size * 0.62;         // 横线 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > bgR) {
        rgba[i + 3] = 0; // 背景外透明
        continue;
      }
      // 圆形背景：蓝色渐变（上浅下深）
      const t = y / size;
      rgba[i] = Math.round(58 + (24 - 58) * t);      // R
      rgba[i + 1] = Math.round(120 + (70 - 120) * t); // G
      rgba[i + 2] = Math.round(235 + (170 - 235) * t); // B
      rgba[i + 3] = 255;

      // 白色剪贴板主体
      if (inRoundRect(x, y, boardX, boardTop, boardW, boardH, radius)) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
      }
      // 顶部夹子
      const clipX = cx - boardW * 0.28;
      if (x >= clipX && x <= cx + boardW * 0.28 && y >= boardTop - clipH * 0.6 && y <= boardTop + clipH * 0.4) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
      }
      // 两条蓝色横线（文字行）
      const lineHalf = boardW * 0.30;
      const lineThick = Math.max(1, size * 0.03);
      for (const lineY of [lineY1, lineY2]) {
        if (Math.abs(y - lineY) < lineThick && x >= cx - lineHalf && x <= cx + lineHalf) {
          rgba[i] = 70; rgba[i + 1] = 120; rgba[i + 2] = 235;
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

/** 把多张 PNG 打包为 Windows ICO 文件（Vista+ 支持 ICO 内嵌 PNG 图层） */
function encodeIco(images) {
  const count = images.length;
  const headerSize = 6 + count * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);                 // reserved
  header.writeUInt16LE(1, 2);                 // type: icon
  header.writeUInt16LE(count, 4);             // 图层数量
  let offset = headerSize;
  const chunks = [];
  images.forEach((img, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = img.size >= 256 ? 0 : img.size; // width（256 记作 0）
    entry[1] = img.size >= 256 ? 0 : img.size; // height
    entry[2] = 0;                              // 颜色数（0 = 默认）
    entry[3] = 0;                              // reserved
    entry.writeUInt16LE(1, 4);                 // planes
    entry.writeUInt16LE(32, 6);                // bit count
    entry.writeUInt32LE(img.png.length, 8);    // 图像数据字节数
    entry.writeUInt32LE(offset, 12);           // 图像数据偏移
    entry.copy(header, 6 + i * 16);
    chunks.push(img.png);
    offset += img.png.length;
  });
  return Buffer.concat([header, ...chunks]);
}

/* ---------- 输出 ---------- */
const outDir = path.join(__dirname, '..', 'build');
const iconsDir = path.join(outDir, 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon.png'), makeIcon(256));
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), makeIcon(32));

// 多分辨率 ICO：16 / 32 / 48 / 256（Windows 专用，嵌入 exe 用）
const sizes = [16, 32, 48, 256];
const images = sizes.map((s) => ({ size: s, png: makeIcon(s) }));
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), encodeIco(images));
console.log('图标已生成：build/icon.png + build/tray-icon.png + build/icons/icon.ico');
