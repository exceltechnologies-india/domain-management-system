'use client';

import { MapPin, MapPinIcon } from 'lucide-react';
import Button from '../Button';
import Input from '../Input';
import { INDIAN_STATES } from '@/lib/constants';
import type { RegisterFormData, RegisterChangeHandler } from './types';

interface Props {
  formData: RegisterFormData;
  onChange: RegisterChangeHandler;
  isDetectingLocation: boolean;
  onDetectLocation: () => void;
}

/**
 * Address Line 1 + city + state + country + zipcode, with a one-click
 * "Auto-fill" button that delegates geocoding to the parent (the geocode
 * logic stays in RegisterForm so it can update the shared formData
 * through setState).
 */
export default function AddressSection({
  formData,
  onChange,
  isDetectingLocation,
  onDetectLocation,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-900 flex items-center">
          <MapPin className="h-5 w-5 text-gray-400 mr-2" />
          Address Information
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDetectLocation}
          disabled={isDetectingLocation}
          loading={isDetectingLocation}
          icon={!isDetectingLocation && <MapPinIcon className="h-4 w-4" />}
          className="text-primary-600"
        >
          Auto-fill
        </Button>
      </div>

      <Input
        label="Address Line 1"
        name="address.line1"
        placeholder="Street address, P.O. box"
        value={formData.address.line1}
        onChange={onChange}
        required
        fullWidth
        icon={<MapPin className="h-4 w-4 text-gray-400" />}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="City"
          name="address.city"
          placeholder="Enter city"
          value={formData.address.city}
          onChange={onChange}
          required
          fullWidth
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            State/Province
          </label>
          <select
            name="address.state"
            value={formData.address.state}
            onChange={onChange}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-gray-900 bg-white"
          >
            <option value="" disabled>
              Select state
            </option>
            {INDIAN_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Country
          </label>
          <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
            🇮🇳 India
          </div>
          <input type="hidden" name="address.country" value="IN" />
        </div>
        <Input
          label="ZIP/Postal Code"
          name="address.zipcode"
          placeholder="Enter ZIP code"
          value={formData.address.zipcode}
          onChange={onChange}
          required
          fullWidth
        />
      </div>
    </div>
  );
}
