/** Lets SSO people in on a proxy-mode server: the first becomes admin, the others are added by e-mail and sign in once. */
export async function admitSsoPeople(baseUrl: string, people: Record<string, string>[]): Promise<void> {
  const [admin, ...others] = people;
  await fetch(`${baseUrl}/api/me`, { headers: admin });
  for (const person of others) {
    const added = await fetch(`${baseUrl}/api/accounts/invitations`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ email: person["remote-email"], role: "member" }),
    });
    if (added.status !== 201) throw new Error(`Could not add ${person["remote-email"]}: ${added.status}`);
    await fetch(`${baseUrl}/api/me`, { headers: person });
  }
}
