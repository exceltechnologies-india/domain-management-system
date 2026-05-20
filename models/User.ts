import mongoose, { Schema, Document } from "mongoose";
import bcrypt from "bcryptjs";
import { encryptField, decryptField } from "@/lib/field-encryption";
import {
  DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES,
  DEFAULT_USER_SESSION_TIMEOUT_MINUTES,
} from "@/config/constants";

/**
 * Mongoose User Document Interface
 * 
 * Defines the TypeScript structure for the User model. It encompasses standard authentication
 * credentials, basic profile data, system status flags, and social login provider data.
 * Additionally, it holds relationships to external systems (ResellerClub, DirectAdmin) 
 * for active provisioning management.
 */
export interface IUser extends Document {
  email: string;
  password?: string; // Made optional for social login users
  firstName: string;
  lastName: string;
  phone?: string; // Made optional for social login users
  phoneCc?: string; // Made optional for social login users
  whatsappNumber?: string; // Optional WhatsApp number for notifications (10 digits, India)
  companyName?: string; // Made optional for social login users
  gstNumber?: string; // Added optional GST number
  address?: {
    // Made optional for social login users
    line1: string;
    city: string;
    state: string;
    country: string;
    zipcode: string;
  };
  role: "admin" | "user";
  isActive: boolean;
  isActivated: boolean;
  sessionInvalidatedAt?: Date | null;
  lastActivityAt?: Date | null;
  sessionTimeoutMinutes?: number; // 15 for admin, 30 for users
  isDeleted?: boolean;
  deletedAt?: Date;
  activationToken?: string;
  activationTokenExpiry?: Date;
  resetToken?: string;
  resetTokenExpiry?: Date;
  pendingEmail?: string;
  pendingEmailToken?: string;
  pendingEmailExpiry?: Date;
  // Social login fields
  provider?: string; // 'google', 'facebook', 'credentials'
  providerId?: string; // Social provider user ID
  profileCompleted?: boolean; // Track if user has completed profile setup
  isGuest?: boolean; // True for guest checkout accounts (no password set yet)
  resellerClubCustomerId?: number; // ResellerClub customer ID for API operations
  resellerClubContactId?: number; // ResellerClub contact ID attached to this user's domains
  directAdminUsername?: string; // DirectAdmin username for hosting operations
  hostingCreatedAt?: Date; // When hosting was provisioned
  hostingExpiresAt?: Date; // When hosting expires
  cart?: Array<{
    domainName: string;
    price: number;
    currency: string;
    registrationPeriod: number;
    itemType?: "domain" | "hosting";
    hostingPlan?: {
      name: string;
      period: number;
      features: string[];
      serverPackage?: string;
    };
  }>;
  // TOTP 2FA — fields are select:false; never returned by default queries
  totpEnabled: boolean;
  totpSecret?: string;
  totpSecretPending?: string;
  totpBackupCodes?: string[];
  passwordChangedAt?: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

/**
 * Mongoose Schema definition for the application's primary User entity.
 * 
 * This schema manages user credentials, role-based access control (RBAC), and 
 * keeps track of user shopping carts and active sessions. It enforces email uniqueness.
 */
const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function (): boolean {
        return !this.provider || this.provider === "credentials";
      },
      minlength: 6,
      // Default: NEVER include the bcrypt hash in queries. Auth-only call
      // sites (lib/services/users.ts → getUserWithPassword, the credentials
      // provider's `authorize`, the change-email re-auth) explicitly opt-in
      // via `.select("+password")`. Anything else that grabbed the field
      // historically was an accidental leak — `JSON.stringify(user)` would
      // serialise the hash into API responses without any caller noticing.
      select: false,
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    phoneCc: {
      type: String,
      trim: true,
    },
    whatsappNumber: {
      type: String,
      trim: true,
    },
    companyName: {
      type: String,
      trim: true,
    },
    gstNumber: {
      type: String,
      trim: true,
      // AES-256-GCM encrypted at rest. maxlength removed — ciphertext is longer than plaintext.
      // Access via getter/setter which transparently encrypt/decrypt.
      get: (v: string) => {
        if (!v || !process.env.FIELD_ENCRYPTION_KEY) return v;
        try { return decryptField(v); } catch { return v; }
      },
      set: (v: string) => {
        if (!v || !process.env.FIELD_ENCRYPTION_KEY) return v;
        try { return encryptField(v); } catch { return v; }
      },
    },
    address: {
      line1: {
        type: String,
        trim: true,
      },
      city: {
        type: String,
        trim: true,
      },
      state: {
        type: String,
        trim: true,
      },
      country: {
        type: String,
        trim: true,
        default: "IN",
      },
      zipcode: {
        type: String,
        trim: true,
      },
    },
    role: {
      type: String,
      enum: ["admin", "user"],
      default: "user",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isActivated: {
      type: Boolean,
      default: false,
    },
    sessionInvalidatedAt: {
      type: Date,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: null,
    },
    sessionTimeoutMinutes: {
      type: Number,
      default: function (): number {
        return this.role === "admin"
          ? DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES
          : DEFAULT_USER_SESSION_TIMEOUT_MINUTES;
      },
    },
    // Social login fields
    provider: {
      type: String,
      enum: ["google", "facebook", "credentials"],
      default: "credentials",
    },
    providerId: {
      type: String,
    },
    profileCompleted: {
      type: Boolean,
      default: false,
    },
    isGuest: {
      type: Boolean,
      default: false,
    },
    resellerClubCustomerId: {
      type: Number,
    },
    resellerClubContactId: {
      type: Number,
    },
    directAdminUsername: {
      type: String,
      trim: true,
    },
    hostingCreatedAt: {
      type: Date,
    },
    hostingExpiresAt: {
      type: Date,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
    activationToken: {
      type: String,
    },
    activationTokenExpiry: {
      type: Date,
    },
    resetToken: {
      type: String,
      // Same reasoning as `password` — the reset-token is live cred
      // material until the expiry. Reset flows opt-in via
      // `findUserByResetToken` which calls `.select("+resetToken
      // +resetTokenExpiry")`.
      select: false,
    },
    resetTokenExpiry: {
      type: Date,
      select: false,
    },
    pendingEmail: {
      type: String,
    },
    pendingEmailToken: {
      type: String,
      select: false,
    },
    pendingEmailExpiry: {
      type: Date,
    },
    totpEnabled: {
      type: Boolean,
      default: false,
    },
    totpSecret: {
      type: String,
      select: false,
    },
    totpSecretPending: {
      type: String,
      select: false,
    },
    totpBackupCodes: {
      type: [String],
      select: false,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    cart: [
      {
        domainName: {
          type: String,
          required: true,
        },
        price: {
          type: Number,
          required: true,
        },
        currency: {
          type: String,
          required: true,
        },
        registrationPeriod: {
          type: Number,
          required: true,
        },
        periodUnit: {
          type: String,
          enum: ["months", "years", "minutes", "days"],
          default: "months",
        },
        itemType: {
          type: String,
          enum: ["domain", "hosting"],
          default: "domain",
        },
        linkedDomain: {
          type: String,
          trim: true,
        },
        hostingPlan: {
          name: String,
          period: Number,
          features: [String],
          serverPackage: String,
        },
      },
    ],
  },
  {
    timestamps: true,
    // Required for Mongoose getter/setter functions to run when converting to JSON/Object
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

/**
 * Pre-save Database Hook
 *
 * Intercepts saving the User document to securely hash their password
 * using bcrypt before committing it to the database. This hook only runs
 * if the password field is modified and applies only to users relying
 * on local credentials (not exclusively social login).
 */
// Indexes for queries the app actually performs.
// `email` already has a unique index from the field definition above.
UserSchema.index({ role: 1 });
UserSchema.index({ activationToken: 1 }, { sparse: true });
UserSchema.index({ resetToken: 1 }, { sparse: true });
UserSchema.index({ pendingEmailToken: 1 }, { sparse: true });
UserSchema.index({ directAdminUsername: 1 }, { sparse: true });
UserSchema.index({ resellerClubCustomerId: 1 }, { sparse: true });

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();

  // Only hash password for credential-based users
  if (this.provider === "credentials" || !this.provider) {
    try {
      const salt = await bcrypt.genSalt(12);
      this.password = await bcrypt.hash(this.password, salt);
      this.passwordChangedAt = new Date();
      next();
    } catch (error: any) {
      next(error);
    }
  } else {
    next();
  }
});

// Compare password method
UserSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  // If no password is stored, return false
  if (!this.password) {
    return false;
  }

  // Compare the password (works for users with password regardless of provider)
  // This allows users who registered with credentials to still login with password
  // even if they later linked a social account
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if the model already exists
let User: mongoose.Model<IUser>;

try {
  User = mongoose.model<IUser>("User");
} catch (error) {
  // Model doesn't exist, create it
  User = mongoose.model<IUser>("User", UserSchema);
}

export default User;
