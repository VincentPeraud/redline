import { useState } from "react";
import type { DesignSystemSwitchPreview, SwitchComponent } from "@redline/shared";
import { counted } from "./plural.js";
import { switchMatchLabel } from "./projectDesignSystemLabels.js";
import { Button, DIALOG_EXIT_MS, Dialog, DialogActions, cx } from "./ui/index.js";
import styles from "./SwitchDesignSystemDialog.module.css";

const usesOf = (component: SwitchComponent) => `${counted(component.instances, "instance", "instances")} · ${component.pages === 1 ? component.page : counted(component.pages, "page", "pages")}`;

/** "Passer App sur Réseaux sociaux": the used design system components, compared with the target, and what the switch breaks. */
export function SwitchDesignSystemDialog({
  projectTitle,
  fromTitle,
  preview,
  onConfirm,
  onClose,
}: {
  projectTitle: string;
  fromTitle: string;
  preview: DesignSystemSwitchPreview;
  onConfirm: (ticked: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [ticked, setTicked] = useState(() => new Set(preview.components.filter((c) => c.match === "same").map((c) => c.tag)));
  const [closing, setClosing] = useState(false);
  const broken = preview.components.filter((c) => c.match === "absent" || !ticked.has(c.tag)).reduce((total, c) => total + c.instances, 0);

  function close(after: () => void) {
    setClosing(true);
    setTimeout(after, DIALOG_EXIT_MS);
  }
  const toggle = (tag: string) =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });

  return (
    <Dialog title={`Passer ${projectTitle} sur ${preview.to.title}`} onClose={() => close(onClose)} width={680} gap={20} closing={closing}>
      <p className={styles.lead}>
        Les composants cochés prennent la version de {preview.to.title}. Les autres s'afficheront en erreur dans leurs pages, jusqu'à ce que tu décides quoi en faire. Rien n'est converti automatiquement.
      </p>
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          Composants de {fromTitle} utilisés dans {projectTitle} · {preview.components.length}
        </h3>
        <div className={styles.list} data-testid="switch-components">
          {preview.components.map((component) => {
            const absent = component.match === "absent";
            return (
              <label key={component.tag} className={cx(styles.row, absent && styles.rowAbsent)} data-testid={`switch-${component.name}`}>
                <input type="checkbox" className={styles.checkbox} checked={!absent && ticked.has(component.tag)} disabled={absent} onChange={() => toggle(component.tag)} />
                <span className={styles.tag}>{component.tag}</span>
                <span className={styles.uses}>{usesOf(component)}</span>
                <span className={cx(styles.pill, styles[component.match])}>{switchMatchLabel(component, preview.to.title)}</span>
              </label>
            );
          })}
        </div>
        <div className={styles.note}>
          « Mêmes réglages » : mêmes variantes et mêmes emplacements de contenu. Redline ne sait pas si le composant a le même rôle : décoche-le si ce n'est pas le même.
        </div>
      </section>
      {preview.own.length > 0 && <div className={styles.own}>{`Les composants propres au projet (${preview.own.join(", ")}) ne changent pas.`}</div>}
      <div className={styles.footer}>
        <span data-testid="switch-broken" className={styles.broken}>
          {broken === 0 ? "Aucune instance en erreur" : `${counted(broken, "instance", "instances")} en erreur après le changement`}
        </span>
        <DialogActions>
          <Button size="lg" onClick={() => close(onClose)}>
            Annuler
          </Button>
          <Button variant="accent" size="lg" onClick={() => close(() => void onConfirm([...ticked]))}>
            Changer de design system
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
