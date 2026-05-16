import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

function checkProfileCompletion(user: any): boolean {
  // Check if all required fields are filled
  const hasPhone = user.phone && user.phone.trim() !== "";
  const hasPhoneCc = user.phoneCc && user.phoneCc.trim() !== "";
  const hasCompanyName = user.companyName && user.companyName.trim() !== "";
  const hasAddress = user.address?.line1 && user.address.line1.trim() !== "";
  const hasCity = user.address?.city && user.address.city.trim() !== "";
  const hasState = user.address?.state && user.address.state.trim() !== "";
  const hasCountry = user.address?.country && user.address.country.trim() !== "";
  const hasZipcode = user.address?.zipcode && user.address.zipcode.trim() !== "";

  return (
    hasPhone &&
    hasPhoneCc &&
    hasCompanyName &&
    hasAddress &&
    hasCity &&
    hasState &&
    hasCountry &&
    hasZipcode
  );
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // Get user from JWT token
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { phone, phoneCc, companyName, gstNumber, address } = body;

    // Update user profile
    if (phone) user.phone = phone;
    if (phoneCc) user.phoneCc = phoneCc;
    if (companyName) user.companyName = companyName;
    if (gstNumber !== undefined) user.gstNumber = gstNumber;

    // Initialize address object if it doesn't exist
    if (!user.address) {
      user.address = {
        line1: "",
        city: "",
        state: "",
        country: "IN", // Default to India
        zipcode: "",
      };
    }

    // Update address fields
    if (address) {
      if (address.line1 !== undefined) user.address.line1 = address.line1;
      if (address.city !== undefined) user.address.city = address.city;
      if (address.state !== undefined) user.address.state = address.state;
      if (address.country !== undefined) user.address.country = address.country;
      if (address.zipcode !== undefined) user.address.zipcode = address.zipcode;
    }

    // Check if profile is completed
    const isProfileComplete = checkProfileCompletion(user);
    user.profileCompleted = isProfileComplete;

    await user.save();

    serverLogger.info('Profile completion:', {
      userId: user._id,
      isProfileComplete,
      phone: user.phone,
      phoneCc: user.phoneCc,
      companyName: user.companyName,
      address: user.address
    });

    // Return updated user data
    const updatedUser = {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      phoneCc: user.phoneCc,
      companyName: user.companyName,
      gstNumber: user.gstNumber,
      address: user.address,
      profileCompleted: user.profileCompleted,
      role: user.role,
      provider: user.provider,
    };

    return NextResponse.json({
      message: "Profile completed successfully",
      user: updatedUser,
    });
  } catch (error) {
    serverLogger.error("Profile completion error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}