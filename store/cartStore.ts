import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { CartItem } from "@/lib/types";
import { safeLocalStorage } from "@/lib/storage";
import { isRestricted } from "@/lib/tld-policies";
import toast from "react-hot-toast";
import { logger } from "@/lib/logger";
import {
  validateAndCorrectCartItems,
  clampRegistrationPeriod,
} from "./cart-validation";

// Debounce timer — batches rapid cart mutations into a single server sync
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

const debouncedSave = (saveFn: () => Promise<void>) => {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => { saveFn(); }, SAVE_DEBOUNCE_MS);
};

interface CartStore {
  items: CartItem[];
  isLoading: boolean;
  isInitialized: boolean;
  addItem: (item: CartItem) => void;
  removeItem: (domainName: string, itemType?: string) => void;
  updateItem: (domainName: string, updates: Partial<CartItem>, itemType?: string) => void;
  clearCart: () => void;
  getTotalPrice: () => number;
  getSubtotalPrice: () => number;
  getItemCount: () => number;
  hasDomainItems: () => boolean;
  hasHostingItems: () => boolean;
  syncWithServer: () => Promise<void>;
  loadFromServer: () => Promise<void>;
  saveToServer: () => Promise<void>;
  mergeWithServerCart: () => Promise<void>;
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      isLoading: false,
      isInitialized: false,

      addItem: (item) => {
        // Block restricted TLDs at add time — we cannot fulfil these
        // (local presence required). Bail with a clear toast instead of
        // silently adding then dropping at server-side validation.
        if ((!item.itemType || item.itemType === 'domain') && isRestricted(item.domainName)) {
          toast.error(`${item.domainName} requires local presence we can't fulfil. Please choose a different TLD.`, { duration: 5000 });
          return;
        }

        set((state) => {
          // Clamp the incoming period into the TLD-specific [min, max] window
          // (or the hosting window when itemType === 'hosting').
          const clamped = clampRegistrationPeriod({
            domainName: item.domainName,
            itemType: item.itemType,
            registrationPeriod: item.registrationPeriod,
          });
          const validatedItem = {
            ...item,
            itemType: (item.itemType || 'domain') as 'domain' | 'hosting',
            registrationPeriod: clamped,
          };


          // Check for existence by domain AND type to prevent duplicates of same type
          const newItemType = validatedItem.itemType || 'domain';
          

          const existingItem = state.items.find((i) => {
             const existingType = i.itemType || 'domain';
             return i.domainName === validatedItem.domainName && existingType === newItemType;
          });

          if (existingItem) {
            return {
              items: state.items.map((i) => {
                const currentType = i.itemType || 'domain';
                return (i.domainName === validatedItem.domainName && currentType === newItemType)
                  ? { ...i, ...validatedItem }
                  : i;
              }),
            };
          }

          return {
            items: [...state.items, validatedItem],
          };
        });

        // Debounced save — batches rapid adds into a single request.
        // No client-side auth gate: saveToServer relies on the NextAuth
        // session cookie (credentials:"include") and fails-soft on 401
        // for guests. The previous localStorage "token" gate broke after
        // the NextAuth-only migration — that key is never written for
        // credentials login, so authenticated users' carts stopped
        // persisting server-side.
        debouncedSave(() => get().saveToServer());
      },

      removeItem: (domainName, itemType) => {
        set((state) => {
          const withoutDomain = state.items.filter((item) => {
            if (itemType) {
              if (itemType === 'domain') {
                return !(item.domainName === domainName && (!item.itemType || item.itemType === 'domain'));
              }
              return !(item.domainName === domainName && item.itemType === itemType);
            }
            return item.domainName !== domainName;
          });

          // When a domain is removed, also drop any hosting item linked to it
          if (itemType === 'domain' || !itemType) {
            const withoutLinkedHosting = withoutDomain.filter(
              item => !(item.itemType === 'hosting' && item.domainName === domainName)
            );
            if (withoutLinkedHosting.length < withoutDomain.length) {
              toast(`Hosting plan removed because ${domainName} was removed from your cart.`, { duration: 4000 });
            }
            return { items: withoutLinkedHosting };
          }

          return { items: withoutDomain };
        });

        debouncedSave(() => get().saveToServer());
      },

      updateItem: (domainName, updates, itemType) => {
        set((state) => ({
          items: state.items.map((item) =>
            (item.domainName === domainName && (!itemType || item.itemType === itemType))
               ? { ...item, ...updates } 
               : item
          ),
        }));

        debouncedSave(() => get().saveToServer());
      },

      clearCart: () => {
        set({ items: [] });

        debouncedSave(() => get().saveToServer());
      },

      getSubtotalPrice: () => {
        return get().items.reduce(
          (total, item) => total + item.price * item.registrationPeriod,
          0
        );
      },

      getTotalPrice: () => {
        const subtotal = get().getSubtotalPrice();
        return Math.round(subtotal * 100) / 100; // Round to 2 decimal places
      },

      getItemCount: () => {
        return get().items.length;
      },

      hasDomainItems: () => {
        return get().items.some(item => !item.itemType || item.itemType === 'domain');
      },

      hasHostingItems: () => {
        return get().items.some(item => item.itemType === 'hosting');
      },

      syncWithServer: async () => {
        const { isInitialized } = get();
        if (isInitialized) return;

        set({ isLoading: true });
        try {
          // Check if we have local cart items before loading from server
          const localItems = get().items;
          const hasLocalItems = localItems.length > 0;

          await get().loadFromServer();

          // If we had local items and server cart is empty, merge them
          if (hasLocalItems) {
            const serverItems = get().items;
            if (serverItems.length === 0) {
              // Server cart is empty, keep local items and save to server
              set({ items: localItems });
              await get().saveToServer();
            } else {
              // Server has items, merge with local items (avoid duplicates)
              const mergedItems = [...serverItems];
              localItems.forEach((localItem) => {
                const localType = localItem.itemType || 'domain';
                const exists = mergedItems.find(
                  (item) => item.domainName === localItem.domainName && (item.itemType || 'domain') === localType
                );
                if (!exists) {
                  mergedItems.push(localItem);
                }
              });
              set({ items: mergedItems });
              await get().saveToServer();
            }
          }

          // Validate all items one final time before marking as initialized
          const finalItems = get().items;
          const validatedFinalItems = validateAndCorrectCartItems(finalItems);
          set({ items: validatedFinalItems, isInitialized: true });
        } catch (error: unknown) {
          // Only log non-abort errors to reduce noise in development
          const err = error as { code?: string; name?: string };
          if (err.code !== "ECONNRESET" && err.name !== "AbortError") {
            logger.error("Failed to sync cart with server", error);
          }
        } finally {
          set({ isLoading: false });
        }
      },

      loadFromServer: async () => {
        try {
          // Auth via the NextAuth session cookie carried by
          // credentials:"include". A guest (no session) gets a 401 from
          // /api/cart, which falls through the `response.ok` branch as
          // a no-op — fail-soft. The previous Bearer-token gate was a
          // dead pre-NextAuth path.
          const response = await fetch("/api/cart", {
            method: "GET",
            credentials: "include",
          });

          if (response.ok) {
            const data = await response.json();
            const validatedItems = validateAndCorrectCartItems(data.cart || []);
            set({ items: validatedItems });
            if (Array.isArray(data.dropped) && data.dropped.length > 0) {
              toast.error(
                `Removed restricted domain${data.dropped.length > 1 ? "s" : ""} from your cart: ${data.dropped.join(", ")}`,
                { duration: 6000 }
              );
            }
          }
        } catch (error: unknown) {
          // Only log non-abort errors to reduce noise in development
          const err = error as { code?: string; name?: string };
          if (err.code !== "ECONNRESET" && err.name !== "AbortError") {
            logger.error("Failed to load cart from server", error);
          }
        }
      },

      saveToServer: async () => {
        try {
          const { items } = get();

          const response = await fetch("/api/cart", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({ cart: items }),
          });

          if (response.ok) {
            // Cart saved successfully
          }
        } catch (error: unknown) {
          // Only log non-abort errors to reduce noise in development
          const err = error as { code?: string; name?: string };
          if (err.code !== "ECONNRESET" && err.name !== "AbortError") {
            logger.error("Failed to save cart to server", error);
          }
        }
      },

      mergeWithServerCart: async () => {
        try {
          const localItems = get().items;
          if (localItems.length === 0) return;

          // Load server cart via the NextAuth session cookie. 401 falls
          // through as no-op (fail-soft for guests).
          const response = await fetch("/api/cart", {
            method: "GET",
            credentials: "include",
          });

          if (response.ok) {
            const data = await response.json();
            const serverItems = data.cart || [];

            // Merge local items with server items (avoid duplicates)
            const mergedItems = [...serverItems];
            localItems.forEach((localItem) => {
              const localType = localItem.itemType || 'domain';
              const exists = mergedItems.find(
                (item) => item.domainName === localItem.domainName && (item.itemType || 'domain') === localType
              );
              if (!exists) {
                mergedItems.push(localItem);
              }
            });

            // Validate and correct all merged items
            const validatedItems = validateAndCorrectCartItems(mergedItems);
            set({ items: validatedItems });

            // Save merged cart to server
            await get().saveToServer();
          }
        } catch (error: unknown) {
          // Only log non-abort errors to reduce noise in development
          const err = error as { code?: string; name?: string };
          if (err.code !== "ECONNRESET" && err.name !== "AbortError") {
            logger.error("Failed to merge cart with server", error);
          }
        }
      },
    }),
    {
      name: "cart-storage",
      storage: createJSONStorage(() => safeLocalStorage),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Validate and correct all items when store is rehydrated from localStorage
          const validatedItems = validateAndCorrectCartItems(state.items);
          if (JSON.stringify(validatedItems) !== JSON.stringify(state.items)) {
            state.items = validatedItems;
            // Push the validation-corrected cart back to the server. The
            // NextAuth cookie carries auth; saveToServer is a no-op on 401
            // for guests.
            setTimeout(() => {
              useCartStore.getState().saveToServer();
            }, 100);
          }
        }
      },
    }
  )
);
