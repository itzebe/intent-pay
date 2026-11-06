// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// framer-motion's exit animations keep React's act() pending; the layout rule
// under test (where the overlay is attached) is independent of animation.
vi.mock("framer-motion", () => {
  const strip = (props: Record<string, any>) => {
    const { initial, animate, exit, transition, variants, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef((props: any, ref: any) =>
          React.createElement(tag, { ...strip(props), ref }),
        ),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children),
  };
});

import { Modal } from "@/components/ui/Modal";

/**
 * The wallet picker (and every other modal) must render into `document.body`,
 * not where its trigger lives.
 *
 * `position: fixed` is resolved against the nearest ancestor that establishes a
 * containing block, and a `backdrop-filter` (the sticky header's
 * `backdrop-blur-xl`) is one. A modal mounted inside that header was laid out
 * against the 69px header instead of the viewport, so the wallet rows rendered
 * off-screen and could not be clicked — the "can't connect a wallet" defect.
 * This is a jsdom test: it asserts the DOM placement that makes the fix work,
 * not the CSS engine (covered by the Playwright harness).
 */
describe("Modal portal", () => {
  afterEach(() => cleanup());

  it("attaches the overlay to document.body, outside any filtered ancestor", () => {
    const { container } = render(
      <header style={{ backdropFilter: "blur(24px)" }} className="filtered-ancestor">
        <Modal open onClose={() => {}} title="Connect a wallet">
          <button>Trust Wallet</button>
        </Modal>
      </header>,
    );

    const dialog = screen.getByRole("dialog");
    // The overlay is the dialog's parent (the fixed inset-0 layer).
    const overlay = dialog.parentElement!;

    // It is a direct child of <body>, not nested inside the filtered header —
    // which is exactly what keeps `inset-0` sized to the viewport.
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.closest(".filtered-ancestor")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders nothing when closed and portals only when open", () => {
    const { rerender } = render(
      <div>
        <Modal open={false} onClose={() => {}} title="Connect a wallet">
          <button>Trust Wallet</button>
        </Modal>
      </div>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <div>
        <Modal open onClose={() => {}} title="Connect a wallet">
          <button>Trust Wallet</button>
        </Modal>
      </div>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement!.parentElement).toBe(document.body);
  });
});
