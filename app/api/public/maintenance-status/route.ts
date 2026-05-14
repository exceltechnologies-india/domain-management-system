import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongoose';
import Settings from '@/models/Settings';

export async function GET() {
  try {
    await connectToDatabase();
    const setting = await Settings.findOne({ key: 'maintenance_mode' }).lean() as any;

    if (!setting?.value) {
      return NextResponse.json({ enabled: false, message: '', scheduledEnd: null });
    }

    const { enabled, message, scheduledEnd } = setting.value;

    // Auto-expire if scheduled end has passed
    if (enabled && scheduledEnd && new Date(scheduledEnd) <= new Date()) {
      await Settings.updateOne(
        { key: 'maintenance_mode' },
        { $set: { 'value.enabled': false, updatedAt: new Date() } }
      );
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
