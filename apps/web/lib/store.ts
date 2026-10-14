"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Selection {
  eventId: string;
  marketId: string;
  marketOnchainId: number;
  outcomeIndex: number;
  outcomeLabel: string;
  marketTitle: string;
  eventLabel: string;
  displayedOdds: string; // odds as shown when clicked (indexed read model) — NOT what gets locked
}

interface BetSlipState {
  selection: Selection | null;
  stake: string;
  open: boolean; // mobile drawer
  select: (s: Selection) => void;
  clear: () => void;
  setStake: (v: string) => void;
  setOpen: (v: boolean) => void;
}

export const useBetSlip = create<BetSlipState>((set) => ({
  selection: null,
  stake: "25",
  open: false,
  select: (selection) => set({ selection, open: true }),
  clear: () => set({ selection: null, open: false }),
  setStake: (stake) => set({ stake }),
  setOpen: (open) => set({ open }),
}));

interface AdminSessionState {
  token: string | null;
  address: string | null;
  expiresAt: string | null;
  roles: string[];
  setSession: (s: { token: string; address: string; expiresAt: string; roles: string[] }) => void;
  clearSession: () => void;
}

/** The session token is a short-lived bearer token (not a key); it is kept in sessionStorage only. */
export const useAdminSession = create<AdminSessionState>()(
  persist(
    (set) => ({
      token: null,
      address: null,
      expiresAt: null,
      roles: [],
      setSession: (s) => set(s),
      clearSession: () => set({ token: null, address: null, expiresAt: null, roles: [] }),
    }),
    {
      name: "fairplay.admin",
      storage: {
        getItem: (k) => {
          try {
            const v = sessionStorage.getItem(k);
            return v ? JSON.parse(v) : null;
          } catch {
            return null;
          }
        },
        setItem: (k, v) => {
          try {
            sessionStorage.setItem(k, JSON.stringify(v));
          } catch {}
        },
        removeItem: (k) => {
          try {
            sessionStorage.removeItem(k);
          } catch {}
        },
      },
    },
  ),
);
