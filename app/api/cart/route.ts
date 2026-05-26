import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { clearUserCart, getUserCart, setUserCart } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { getMinYears, getMaxYears, isRestricted } from "@/lib/tld-policies";
import { validatedBody, z } from "@/lib/api-validation";

// Server-side cart sync: keep the schema loose with `.passthrough()` —
// the route already runs `validateAndCorrectCartItems` to drop restricted
// TLDs + clamp periods. We just need to gate the envelope (array of
// objects with at minimum the domainName/itemType/registrationPeriod
// shape) so a malformed body fails fast instead of feeding `cart` into
// the validator as an arbitrary value.
const cartItemSchema = z.object({
  domainName: z.string().min(1).max(253).optional(),
  itemType: z.enum(["domain", "hosting"]).optional(),
  registrationPeriod: z.number().int().positive().max(120).optional(),
}).passthrough();

const cartSyncSchema = z.object({
  cart: z.array(cartItemSchema).max(50),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// Raw shape we trust the validator with. Mongoose stores the cart as an opaque
// `unknown[]` (see lib/services/users.ts:getUserCart) — narrow at the validator
// boundary to the only fields this function touches. Foreign fields pass
// through untouched.
interface RawCartItem {
  domainName?: string;
  itemType?: 'domain' | 'hosting';
  registrationPeriod?: number;
  [key: string]: unknown;
}

/**
 * Sanitise a cart against the central TLD policy registry:
 *  - drop restricted TLDs (we can't fulfil them, so don't let them sit in cart)
 *  - clamp registrationPeriod into [min, max] for the TLD
 */
const validateAndCorrectCartItems = (
  items: RawCartItem[]
): { cart: RawCartItem[]; dropped: string[] } => {
  const dropped: string[] = [];
  const cart: RawCartItem[] = [];
  for (const item of items) {
    // Pass through non-domain items unchanged
    if (item?.itemType === 'hosting') {
      cart.push(item);
      continue;
    }
    if (!item?.domainName) {
      cart.push(item);
      continue;
    }
    if (isRestricted(item.domainName)) {
      dropped.push(item.domainName);
      continue;
    }
    const min = getMinYears(item.domainName);
    const max = getMaxYears(item.domainName);
    const current = item.registrationPeriod ?? 1;
    let next = current;
    if (next < min) next = min;
    if (next > max) next = max;
    cart.push(next !== current ? { ...item, registrationPeriod: next } : item);
  }
  return { cart, dropped };
};

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's cart (empty array if missing)
    const rawCart = await getUserCart(String(user._id));

    // Validate and correct cart items
    const { cart: validatedCart, dropped } = validateAndCorrectCartItems(rawCart as RawCartItem[]);

    // If cart was corrected, save it back to the database
    if (JSON.stringify(validatedCart) !== JSON.stringify(rawCart)) {
      await setUserCart(String(user._id), validatedCart);
    }

    return NextResponse.json({
      success: true,
      cart: validatedCart,
      ...(dropped.length > 0 ? { dropped } : {}),
    });
  } catch (error) {
    serverLogger.error("Get cart error:", error);
    return NextResponse.json(
      { error: "Failed to fetch cart" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, cartSyncSchema);
    if (!validation.ok) return validation.response;
    const { cart } = validation.data;

    // Validate and correct cart items before saving
    const { cart: validatedCart, dropped } = validateAndCorrectCartItems(cart);

    // Update user's cart with validated data
    await setUserCart(String(user._id), validatedCart);

    return NextResponse.json({
      success: true,
      message: dropped.length > 0
        ? `Cart updated. Removed ${dropped.length} restricted domain${dropped.length > 1 ? "s" : ""} we cannot register: ${dropped.join(", ")}`
        : "Cart updated successfully",
      ...(dropped.length > 0 ? { dropped } : {}),
    });
  } catch (error) {
    serverLogger.error("Update cart error:", error);
    return NextResponse.json(
      { error: "Failed to update cart" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Clear user's cart
    await clearUserCart(String(user._id));

    return NextResponse.json({
      success: true,
      message: "Cart cleared successfully",
    });
  } catch (error) {
    serverLogger.error("Clear cart error:", error);
    return NextResponse.json(
      { error: "Failed to clear cart" },
      { status: 500 }
    );
  }
}
