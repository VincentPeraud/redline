export function projectCountLabel(count: number): string {
  return `${count} projet${count > 1 ? "s" : ""}`;
}

export function diffusionToastMessage(number: number, projects: number): string {
  return `Diffusion ${number} envoyée à ${projectCountLabel(projects)}`;
}
