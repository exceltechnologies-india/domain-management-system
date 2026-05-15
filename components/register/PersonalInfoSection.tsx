'use client';

import { User, Mail, Phone } from 'lucide-react';
import Input from '../Input';
import type { RegisterFormData, RegisterChangeHandler } from './types';

interface Props {
  formData: RegisterFormData;
  onChange: RegisterChangeHandler;
}

/**
 * First/last name + email + company + phone fields.
 * Country code is fixed to India (+91); rendered as a non-editable display
 * with a hidden input so the form payload still carries the value.
 */
export default function PersonalInfoSection({ formData, onChange }: Props) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Input
          label="First name"
          name="firstName"
          placeholder="Enter your first name"
          value={formData.firstName}
          onChange={onChange}
          required
          fullWidth
          icon={<User className="h-4 w-4 text-gray-400" />}
        />
        <Input
          label="Last name"
          name="lastName"
          placeholder="Enter your last name"
          value={formData.lastName}
          onChange={onChange}
          required
          fullWidth
          icon={<User className="h-4 w-4 text-gray-400" />}
        />
      </div>

      <Input
        label="Email address"
        name="email"
        type="email"
        placeholder="Enter your email address"
        value={formData.email}
        onChange={onChange}
        required
        fullWidth
        icon={<Mail className="h-4 w-4 text-gray-400" />}
      />

      <Input
        label="Company name"
        name="companyName"
        placeholder="Enter your company name"
        value={formData.companyName}
        onChange={onChange}
        required
        fullWidth
        icon={<User className="h-4 w-4 text-gray-400" />}
      />

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Country Code
          </label>
          <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
            🇮🇳 +91 (India)
          </div>
          <input type="hidden" name="phoneCc" value="+91" />
        </div>
        <div className="col-span-2">
          <Input
            label="Phone number"
            name="phone"
            type="tel"
            placeholder="Enter your phone number"
            value={formData.phone}
            onChange={onChange}
            required
            fullWidth
            icon={<Phone className="h-4 w-4 text-gray-400" />}
            helperText="Enter phone number without country code"
          />
        </div>
      </div>
    </>
  );
}
