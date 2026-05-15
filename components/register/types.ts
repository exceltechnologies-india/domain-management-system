/**
 * Shared types for the registration form section components.
 * The parent (RegisterForm.tsx) owns the state; sections receive a slice
 * plus a change handler.
 */

export interface RegisterAddress {
  line1: string;
  city: string;
  state: string;
  country: string;
  zipcode: string;
}

export interface RegisterFormData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
  phone: string;
  phoneCc: string;
  companyName: string;
  address: RegisterAddress;
}

export type RegisterChangeHandler = (
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) => void;
