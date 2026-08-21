import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/session.guard.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string; phase: string } {
    return { status: 'ok', service: 'api', phase: '0-foundation' };
  }
}
