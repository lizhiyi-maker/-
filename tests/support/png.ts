import { crc32, deflateSync } from "node:zlib";
import { TRANSCRIPT_CHUNK } from "@/server/ai/mock-vision";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 在已有 PNG 的 IHDR 之后插入“模拟转写”tEXt 块。 */
export function embedTranscript(png: Uint8Array, transcript: string): Uint8Array {
  const buf = Buffer.from(png);
  const ihdrEnd = 8 + 12 + buf.readUInt32BE(8);
  const text = chunk("tEXt", Buffer.concat([Buffer.from(TRANSCRIPT_CHUNK, "latin1"), Buffer.from([0]), Buffer.from(Buffer.from(transcript, "utf8").toString("base64"), "latin1")]));
  return new Uint8Array(Buffer.concat([buf.subarray(0, ihdrEnd), text, buf.subarray(ihdrEnd)]));
}

/** 生成一个 1x1 的有效 PNG，并内嵌转写文本；不同转写得到不同字节（用于哈希查重）。 */
export function makePng(transcript: string): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const idat = deflateSync(Buffer.from([0, 255, 255, 255]));
  const base = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return embedTranscript(base, transcript);
}
