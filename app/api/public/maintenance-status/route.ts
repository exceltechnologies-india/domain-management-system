import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongoose';
import { getSettingValue, upsertSetting } from '@/lib/services/settings';

interface MaintenanceValue {
  enabled?: boolean;
  message?: string;
  scheduledEnd?: string | null;
}

export async function GET() {
  try {
    await connectToDatabase();
    const value = await getSettingValue<MaintenanceValue>('maintenance_mode');

    if (!value) {
      return NextResponse.json({ enabled: false, message: '', scheduledEnd: null });
    }

    const { enabled, message, scheduledEnd } = value;

    // Auto-expire if scheduled end has passed
    if (enabled && scheduledEnd && new Date(scheduledEnd) <= new Date()) {
      await upsertSetting('maintenance_mode', { ...value, enabled: false });
      return NextResponse.json({ enabled: false, message: message || '', scheduledEnd });
    }

    return NextResponse.json({
      enabled: !!enabled,
      message: message || '',
      scheduledEnd: scheduledEnd || null,
    });
  } catch {
    // On error, fail open — assume maintenance is off so the site stays accessible
    return NextResponse.json({ enabled: false, message: '' });
  }
}
