import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MeResponse } from "@redline/shared";
import { useCloseOnOutsidePointer } from "./useCloseOnOutsidePointer.js";
import { cx } from "./ui/index.js";
import { useSession } from "./useMe.js";
import styles from "./AccountMenu.module.css";

type Me = NonNullable<MeResponse>;

export interface AccountTriggerProps {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

interface Props {
  me: Me;
  /** Up: the menu slides out from behind the trigger, above it (sidebar). Down: from under the header, below the trigger (canvas header). */
  placement: "up" | "down";
  trigger: (props: AccountTriggerProps, open: boolean) => ReactNode;
}

const signOutIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

export function displayName(me: Me): string {
  return me.name || me.id;
}

/**
 * The account menu of the sidebar block and of the canvas header pill. It stays mounted in an overflow-hidden drawer
 * placed against the nearest positioned ancestor, and slides out from behind it.
 */
export function AccountMenu({ me, placement, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = () => setOpen(false);
  const { signOut } = useSession();
  useCloseOnOutsidePointer(root, open, close);

  const triggerElement = () => root.current?.querySelector<HTMLElement>("[aria-haspopup='menu']");
  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  function onWindowKey(event: globalThis.KeyboardEvent) {
    if (event.key !== "Escape") return;
    setOpen(false);
    triggerElement()?.focus();
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, [open]);

  function onTriggerKeyDown(event: KeyboardEvent) {
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key];
    if (next === undefined || all.length === 0) return;
    event.preventDefault();
    all[(next + all.length) % all.length].focus();
  }

  return (
    <div ref={root} className={styles.root} onBlur={(event) => event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget) && close()}>
      {trigger({ "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": menuId, onClick: () => setOpen(!open), onKeyDown: onTriggerKeyDown }, open)}
      <div data-testid="account-drawer" data-open={open} className={cx(styles.drawer, placement === "up" ? styles.up : styles.down)}>
        <div id={menuId} role="menu" aria-label="Compte" className={styles.menu} onKeyDown={onMenuKeyDown}>
          <div className={styles.who}>
            <span className={styles.name}>{displayName(me)}</span>
            <span className={styles.email}>{me.email}</span>
          </div>
          {(me.logoutUrl !== null || (me.account && !me.account.sso)) && (
            <>
              <div className={styles.divider} />
              {me.account && !me.account.sso ? (
                <button type="button" role="menuitem" className={styles.item} onClick={() => void signOut()}>
                  {signOutIcon}
                  Se déconnecter
                </button>
              ) : (
                <a role="menuitem" href={me.logoutUrl!} className={styles.item}>
                  {signOutIcon}
                  Se déconnecter
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
