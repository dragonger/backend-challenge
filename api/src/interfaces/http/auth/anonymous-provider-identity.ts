import { Injectable } from '@nestjs/common';

import type {
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../../application/ports/provider-identity.port.js';

/** No-op implementation: everybody is the anonymous caller (auth is out of scope). */
@Injectable()
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  authenticate(): Promise<ProviderIdentity> {
    return Promise.resolve({ subject: 'anonymous' });
  }
}
