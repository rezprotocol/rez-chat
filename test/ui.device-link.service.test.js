import test from "node:test";
import assert from "node:assert/strict";

import { ChatBus } from "../src/ui/root/ChatBus.js";
import { DeviceLinkService } from "../src/ui/services/bus/DeviceLinkService.js";
import { SessionStore } from "../src/ui/stores/SessionStore.js";
import { LoginCreateAccountView } from "../src/ui/views/LoginCreateAccountView.js";
import { FakeElement, fakeEvent, installFakeDom } from "./_helpers/fakeDom.js";

function makeClient() {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "deviceLink.start") return { linkCode: "rez:link:v1:code", expiresAtMs: 123 };
      if (method === "deviceLink.status") return { state: "pending", newDeviceId: "rez:dev:abc" };
      if (method === "deviceLink.approve") return { state: "responding", newDeviceId: params.newDeviceId };
      if (method === "deviceLink.cancel") return { state: "cancelled" };
      return null;
    },
  };
}

test("DeviceLinkService forwards each directive to the runtime client", async () => {
  const bus = new ChatBus();
  const client = makeClient();
  bus.runtime.client = client;
  const service = new DeviceLinkService({ bus });

  const started = await bus.call("deviceLink", "start", {});
  assert.equal(started.linkCode, "rez:link:v1:code");
  await bus.call("deviceLink", "status", {});
  await bus.call("deviceLink", "approve", { newDeviceId: "rez:dev:abc" });
  await bus.call("deviceLink", "cancel", {});

  assert.deepEqual(client.calls.map((c) => c.method), [
    "deviceLink.start", "deviceLink.status", "deviceLink.approve", "deviceLink.cancel",
  ]);
  assert.equal(client.calls[2].params.newDeviceId, "rez:dev:abc");
  service.stop();
});

test("DeviceLinkService re-emits the runtime deviceLink.updated event as a plain bus event", async () => {
  const bus = new ChatBus();
  bus.runtime.client = makeClient();
  const service = new DeviceLinkService({ bus });
  const seen = [];
  bus.on("deviceLink.updated", (r) => seen.push(r));

  bus.emit("runtime.event.deviceLink.updated", { state: "pending", newDeviceId: "rez:dev:xyz", fingerprint: "aaaa-bbbb-cccc-dddd-eeee" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, "pending");
  assert.equal(seen[0].fingerprint, "aaaa-bbbb-cccc-dddd-eeee");
  service.stop();
});

test("DeviceLinkService fails loud without a connected session", async () => {
  const bus = new ChatBus();
  const service = new DeviceLinkService({ bus });
  await assert.rejects(() => bus.call("deviceLink", "start", {}), /requires a connected session/);
  service.stop();
});

test("link-device form survives working and error re-renders with every field intact", async () => {
  installFakeDom();
  const sessionStore = new SessionStore();
  let submitted = null;
  const bus = {
    stores: { session: sessionStore },
    on() { return () => {}; },
    emit() {},
    call(namespace, name, payload) {
      assert.equal(namespace, "session");
      assert.equal(name, "linkDevice");
      submitted = payload;
      sessionStore.setUnlocking();
      sessionStore.setError("simulated device-link failure");
      return Promise.reject(new Error("simulated device-link failure"));
    },
  };
  const root = new FakeElement("div");
  const view = new LoginCreateAccountView({ bus });
  view.mount(root);

  root.querySelector("[data-action='session.linkThisDevice']").dispatchEvent(fakeEvent("click"));
  root.querySelector("[data-role='link-code']").value = "rez:link:v1:keep-me";
  root.querySelector("[data-role='link-name']").value = "Phone";
  root.querySelector("[data-role='link-password']").value = "password-one";
  root.querySelector("[data-role='link-confirm']").value = "password-one";

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    root.querySelector("[data-role='link-device-form']").dispatchEvent(fakeEvent("submit"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(submitted, {
    linkCode: "rez:link:v1:keep-me",
    name: "Phone",
    password: "password-one",
    confirmPassword: "password-one",
  });
  assert.equal(root.querySelector("[data-role='link-code']").value, "rez:link:v1:keep-me");
  assert.equal(root.querySelector("[data-role='link-name']").value, "Phone");
  assert.equal(root.querySelector("[data-role='link-password']").value, "password-one");
  assert.equal(root.querySelector("[data-role='link-confirm']").value, "password-one");

  view.unmount();
});
