"use client";

import { useEffect } from "react";
import { clearSavedCart } from "@/lib/saved-cart";

/** The order was placed (or is settling), so the next visit starts with an empty order. */
export default function ClearSavedCart() {
  useEffect(() => { clearSavedCart(); }, []);
  return null;
}
