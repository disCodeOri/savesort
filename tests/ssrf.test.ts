import { describe, expect, it } from "vitest";

import { isPrivateIpAddress } from "@/lib/ingestion/ssrf";

describe("isPrivateIpAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.4.2",
    "192.168.1.4",
    "169.254.1.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
  ])("blocks private or local address %s", (address) => {
    expect(isPrivateIpAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPrivateIpAddress(address)).toBe(false);
    },
  );
});
