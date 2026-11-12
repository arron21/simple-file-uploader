import { NextResponse } from 'next/server';
import {
  verifyPassword,
  createSessionToken,
  getSessionCookieOptions,
  isUsingDefaultPassword,
} from '@/lib/auth';
import { getStorageMode } from '@/lib/storage';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!password) {
      return NextResponse.json(
        { error: 'Please enter the access password.' },
        { status: 400 }
      );
    }

    const isValid = verifyPassword(password);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid password. Access denied.' },
        { status: 401 }
      );
    }

    const token = createSessionToken();
    const response = NextResponse.json({
      authenticated: true,
      storageMode: getStorageMode(),
      isDefaultPassword: isUsingDefaultPassword(),
    });

    response.cookies.set({
      ...getSessionCookieOptions(),
      value: token,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: 'Invalid request payload.' },
      { status: 400 }
    );
  }
}
