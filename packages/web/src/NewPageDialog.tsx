import { useState, type FormEvent } from "react";
import {
  starterPageFiles,
  type Conversation,
  type CreateConversationMessageRequest,
  type CreatePageRequest,
  type Page,
  type PageType,
} from "@redline/shared";
import { Button, Dialog, DialogActions, Field, SegmentedControl, TextInput, Textarea } from "./ui/index.js";
import styles from "./NewPageDialog.module.css";

const TYPE_HINT: Record<PageType, string> = {
  prototype: "Enchaîne des écrans en parcours.",
  comparison: "Compare des variantes côte à côte.",
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

export function NewPageDialog({
  projectId,
  projectTitle,
  designSystem,
  onClose,
  onCreated,
}: {
  projectId: string;
  projectTitle: string;
  designSystem: string | null;
  onClose: () => void;
  onCreated: (page: Page) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PageType>("prototype");
  const [instructions, setInstructions] = useState("");
  const canCreate = title.trim() !== "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    const pageTitle = title.trim();
    const body: CreatePageRequest = { title: pageTitle, type, files: starterPageFiles(pageTitle, type, designSystem) };
    const page = await postJson<Page>(`/api/projects/${projectId}/pages`, body);
    if (instructions.trim() !== "") {
      const conversation = await postJson<Conversation>(`/api/pages/${page.id}/conversations`, {});
      const message: CreateConversationMessageRequest = { body: instructions.trim() };
      await postJson(`/api/conversations/${conversation.id}/messages`, message);
    }
    onCreated(page);
  }

  return (
    <Dialog title="Nouvelle page" onClose={onClose} width={520}>
      <form onSubmit={submit} className={styles.form}>
        <Field label="Nom de la page">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Pages d'erreur" />
        </Field>
        <div className={styles.typeField}>
          <span className={styles.typeLabel}>Type</span>
          <SegmentedControl
            ariaLabel="Type de page"
            value={type}
            onChange={setType}
            options={[
              { value: "prototype", label: "Prototype" },
              { value: "comparison", label: "Planche" },
            ]}
          />
          <span className={styles.hint}>{TYPE_HINT[type]}</span>
        </div>
        <Field
          label="Instructions pour Claude"
          optional
          hint={`Ce sera le premier message de la première conversation de la page. Laisse vide pour créer une page vide dans « ${projectTitle} ».`}
        >
          <Textarea
            rows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Décris ce que la page doit contenir : écrans, contenus, cas à couvrir…"
          />
        </Field>
        <DialogActions>
          <Button size="lg" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="accent" size="lg" disabled={!canCreate}>
            Créer la page
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
