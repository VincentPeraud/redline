import type { MouseEvent } from "react";
import { lastKnownTitle, usePageSummary } from "./otherPageArtboards.js";
import type { PageAddress } from "./messageLinks.js";
import { navigateTo, playRoute } from "./router.js";
import { cx } from "./ui/index.js";
import styles from "./AddressPill.module.css";

export interface CurrentPage {
  id: string;
  title: string;
  artboards: { file: string; title: string }[] | null;
}

interface Props {
  address: PageAddress;
  current: CurrentPage;
  /** Centres the canvas on an artboard of the current page, without navigating. */
  onCenter: (file: string) => void;
  /** Shows "Cet artboard n'existe plus" for this file. */
  onMissing: (file: string) => void;
}

function ArtboardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8" />
    </svg>
  );
}

/** An address Claude wrote, shown like a chip: "Artboard · Disponibilités", "Checkout · Panier" or "Page · Checkout". Display only: never a target of the next message. */
export function AddressPill({ address, current, onCenter, onMissing }: Props) {
  const file = address.artboard ?? address.play;
  const samePage = address.pageId === current.id;
  const other = usePageSummary(address.pageId, samePage);
  if (!samePage && other === null) return <PlainLink url={address.url} />;
  const pageTitle = samePage ? current.title : other?.title;
  const titles = samePage ? current.artboards && new Map(current.artboards.map((a) => [a.file, a.title])) : other?.artboardTitles;
  const loading = pageTitle === undefined || !titles;

  const missing = file !== undefined && !!titles && !titles.has(file);
  const title = file === undefined ? (pageTitle ?? "…") : (titles?.get(file) ?? (loading ? undefined : lastKnownTitle(address.pageId, file)) ?? file);
  const prefix = file === undefined ? "Page" : samePage ? "Artboard" : (pageTitle ?? "…");

  function open(event: MouseEvent) {
    event.preventDefault();
    if (loading) return;
    if (file !== undefined && missing) onMissing(file);
    else if (address.play !== undefined) navigateTo(playRoute(address.pageId, address.play, address.renderingParam));
    else if (address.artboard === undefined) navigateTo({ name: "page", pageId: address.pageId });
    else if (samePage) onCenter(address.artboard);
    else navigateTo({ name: "page", pageId: address.pageId, artboard: address.artboard });
  }

  return (
    <a data-testid="address-pill" data-missing={missing || undefined} href={address.url} className={styles.pill} onClick={open}>
      <span aria-hidden="true" className={styles.icon}>
        <ArtboardIcon />
      </span>
      <span className={styles.prefix}>{prefix} ·</span>
      <span className={cx(styles.title, missing && styles.missing)}>{title}</span>
    </a>
  );
}

export function PlainLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className={styles.link}>
      {url}
    </a>
  );
}
