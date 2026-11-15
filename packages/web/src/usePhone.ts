import { useEffect, useState } from "react";

/** Under this width the review step is a bottom sheet (the CSS breakpoint of the phone layout is the same). */
export const PHONE_QUERY = "(max-width: 700px)";

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return phone;
}
