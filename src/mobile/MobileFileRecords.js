import { RRecord } from "@rezprotocol/sdk/client";

export class MobileShareFileV1 extends RRecord {
  static type = "chat.mobile.shareFile.v1";
  constructor(raw) {
    super();
    this.fileName = raw.fileName;
    this.fileDataB64 = raw.fileDataB64;
    this._seal();
  }
  validate() {
    this.assert(typeof this.fileName === "string" && this.fileName.length > 0 && new TextEncoder().encode(this.fileName).length <= 255
      && !/[\/\\\x00-\x1f\x7f]/.test(this.fileName) && this.fileName !== "." && this.fileName !== "..", "Invalid file name");
    this.assert(typeof this.fileDataB64 === "string" && this.fileDataB64.length > 0 && this.fileDataB64.length <= 14_000_000, "Invalid file data");
    const unpadded = this.fileDataB64.replace(/={1,2}$/, "");
    this.assert(this.fileDataB64.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(unpadded), "Invalid file data");
    const byteCount = (this.fileDataB64.length / 4) * 3 - (this.fileDataB64.length - unpadded.length);
    this.assert(byteCount <= 10 * 1024 * 1024, "File is too large");
  }
}

export class MobileShareResultV1 extends RRecord {
  static type = "chat.mobile.shareResult.v1";
  constructor(raw) { super(); this.canceled = raw.canceled; this._seal(); }
  validate() { this.assert(typeof this.canceled === "boolean", "Invalid share result"); }
}
