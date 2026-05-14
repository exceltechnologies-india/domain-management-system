import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";
import { getMinYears, getMaxYears, isRestricted } from "@/lib/tld-policies";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

/**
 * Sanitise a cart against the central TLD policy registry:
 *  - drop restricted TLDs (we can't fulfil them, so don't let them sit in cart)
 *  - clamp registrationPeriod into [min, max] for the TLD
 */
const validateAndCorrectCartItems = (items: any[]): { cart: any[]; dropped: string[] } => {
  const dropped: string[] = [];
  const cart: any[] = [];
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

    await connectDB();

    // Get user with cart data
    const userData = await User.findById(user._id).select("cart");
    if (!userData) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Validate and correct cart items
    const { cart: validatedCart, dropped } = validateAndCorrectCartItems(userData.cart || []);

    // If cart was corrected, save it back to the database
    if (JSON.stringify(validatedCart) !== JSON.stringify(userData.cart)) {
      await User.findByIdAndUpdate(user._id, { cart: validatedCart });
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

    const { cart } = await request.json();

    if (!Array.isArray(cart)) {
      return NextResponse.json({ error: "Invalid cart data" }, { status: 400 });
    }

    await connectDB();

    // Validate and correct cart items before saving
    const { cart: validatedCart, dropped } = validateAndCorrectCartItems(cart);

    // Update user's cart with validated data
    await User.findByIdAndUpdate(user._id, { cart: validatedCart });

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

    await connectDB();

    // Clear user's cart
    await User.findByIdAndUpdate(user._id, { cart: [] });

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
