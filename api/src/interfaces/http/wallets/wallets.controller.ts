import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { GetWallet } from '../../../application/wallet/get-wallet.usecase.js';
import { ListLedger } from '../../../application/wallet/list-ledger.usecase.js';
import { OpenWallet } from '../../../application/wallet/open-wallet.usecase.js';
import { ReconcileWallet } from '../../../application/wallet/reconcile-wallet.usecase.js';
import {
  createWalletSchema,
  ledgerQuerySchema,
  type CreateWalletDto,
  type LedgerQueryDto,
} from '../dto/wallet.dto.js';
import { walletIdParamSchema } from '../dto/common.js';
import { decodeCursor, encodeCursor } from '../pagination/cursor.js';
import { ZodValidationPipe } from '../validation/zod.pipe.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  /** 201 created; 409 when the player already has a wallet in that currency. */
  @Post()
  create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto) {
    return this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(':walletId')
  get(@Param('walletId', new ZodValidationPipe(walletIdParamSchema)) walletId: string) {
    return this.getWallet.execute(walletId);
  }

  /** Ascending by ledger sequence, keyset pagination with an opaque cursor. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ZodValidationPipe(walletIdParamSchema)) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQueryDto,
  ) {
    const page = await this.listLedger.execute({
      walletId,
      afterSequence: query.cursor ? decodeCursor(query.cursor) : undefined,
      limit: query.limit,
    });

    return {
      items: page.items,
      nextCursor: page.nextAfterSequence ? encodeCursor(page.nextAfterSequence) : null,
    };
  }

  /** On-demand audit: reports divergence, never fixes it. Always 200. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId', new ZodValidationPipe(walletIdParamSchema)) walletId: string,
  ) {
    return this.reconcileWallet.execute(walletId);
  }
}
