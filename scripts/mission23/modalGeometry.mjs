// Mission 23 — prove where the wallet picker is actually laid out.
//
// The reported defect: on a phone the "Connect a wallet" button opened a picker
// whose rows could not be tapped. The cause is CSS, not React state — the modal
// was mounted inside the sticky header, whose `backdrop-blur-xl` establishes a
// containing block for `position: fixed`, so the overlay was sized to the 69px
// header instead of the viewport and the rows landed above the visible area.
//
// This harness drives the REAL app (no application mocks — only the wallet is
// stubbed) and prints the overlay/dialog geometry. On the pre-fix build
// `overlayH` is ~68 (the header) and the row `y` is negative; after the fix
// `overlayH` equals `viewportH` and the row is on screen.
//
//   node scripts/mission23/modalGeometry.mjs https://intent-pay-roan.vercel.app
//   node scripts/mission23/modalGeometry.mjs http://localhost:3100
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(() => {
  const p = {
    isMetaMask: true,
    request: async ({ method }) =>
      method === "eth_requestAccounts"
        ? ["0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"]
        : method === "eth_chainId"
          ? "0x8f"
          : null,
    on: () => {},
    removeListener: () => {},
  };
  window.ethereum = p;
  const info = { uuid: "u", name: "MetaMask", icon: "", rdns: "io.metamask" };
  const ann = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: { info, provider: p } }),
    );
  window.addEventListener("eip6963:requestProvider", ann);
  ann();
});
const page = await ctx.newPage();
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: /Connect wallet/i }).first().click();
await page.waitForTimeout(1200);
const geo = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { dialog: null };
  const overlay = dialog.parentElement;
  const dr = dialog.getBoundingClientRect();
  const or = overlay.getBoundingClientRect();
  const row = [...dialog.querySelectorAll("button")].find((b) =>
    /MetaMask|Trust Wallet|Browser wallet/i.test(b.innerText),
  );
  const rr = row ? row.getBoundingClientRect() : null;
  return {
    dialogY: dr.y,
    overlayH: or.height,
    rowY: rr?.y,
    viewportH: window.innerHeight,
    overlayParentTag: overlay.parentElement?.tagName,
  };
});
console.log(base, JSON.stringify(geo));
await browser.close();
