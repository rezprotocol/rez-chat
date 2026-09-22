import test from "node:test";
import assert from "node:assert/strict";
import { MobileShareFileV1, MobileShareResultV1 } from "../src/mobile/MobileFileRecords.js";
import { MobileHostRequestV1 } from "../src/mobile/MobileHostRecords.js";

test("mobile attachment bridge accepts the shared composer's full 10 MiB ceiling", () => {
  const fileDataB64 = Buffer.alloc(10 * 1024 * 1024, 37).toString("base64");
  const share = new MobileShareFileV1({ fileName: "photo.jpg", fileDataB64 });
  const request = new MobileHostRequestV1({ id: "attachment", operation: "bus:file.send", paramsJson: JSON.stringify(share.toJSON()) });
  assert(request.paramsJson.length > 1_000_000);
  assert.throws(() => new MobileShareFileV1({ fileName: "big.jpg", fileDataB64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }), /too large/);
  assert.throws(() => new MobileHostRequestV1({ id: "large", operation: "bus:file.send", paramsJson: "x".repeat(16 * 1024 * 1024 + 1) }), /parameters/);
});

test("mobile file sharing rejects path escapes, invalid base64 and oversized UTF-8 names", () => {
  for (const fileName of ["../secrets", "a/b", "a\\b", ".", "..", "a\u0000b", "é".repeat(128)]) {
    assert.throws(() => new MobileShareFileV1({ fileName, fileDataB64: "AQID" }), /name/);
  }
  for (const fileDataB64 of ["", "a", "AA=A", "=AAA", "====", "A===", "AA\n=", "éééé"]) {
    assert.throws(() => new MobileShareFileV1({ fileName: "photo.jpg", fileDataB64 }), /data/);
  }
  assert.equal(new MobileShareResultV1({ canceled: true }).canceled, true);
  assert.throws(() => new MobileShareResultV1({}), /result/);
});
