-- CreateTable
CREATE TABLE "User" (
    "address" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "onchainId" INTEGER,
    "sport" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "venue" TEXT,
    "description" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "createTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "onchainId" INTEGER,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rules" TEXT NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "simulateOdds" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "outcomeCount" INTEGER NOT NULL,
    "closeTime" TIMESTAMP(3) NOT NULL,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "minStake" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "maxStake" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "maxLiability" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalStake" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "oddsVersion" INTEGER NOT NULL DEFAULT 0,
    "questionId" TEXT,
    "winningOutcome" INTEGER,
    "settledAt" TIMESTAMP(3),
    "createTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "odds" DECIMAL(78,0) NOT NULL,
    "stake" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "grossPayout" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "betCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetIndex" (
    "betId" INTEGER NOT NULL,
    "marketOnchainId" INTEGER NOT NULL,
    "marketId" TEXT,
    "bettor" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "stake" DECIMAL(78,0) NOT NULL,
    "odds" DECIMAL(78,0) NOT NULL,
    "potentialPayout" DECIMAL(78,0) NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "refund" BOOLEAN,
    "payoutAmount" DECIMAL(78,0),
    "placedTxHash" TEXT NOT NULL,
    "placedBlock" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "claimTxHash" TEXT,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "BetIndex_pkey" PRIMARY KEY ("betId")
);

-- CreateTable
CREATE TABLE "OddsHistory" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "odds" TEXT[],
    "version" INTEGER,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "txHash" TEXT,
    "blockNumber" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "OddsHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blockNumber" INTEGER,
    "marketId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "marketOnchainId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "winningOutcome" INTEGER,
    "totalStake" DECIMAL(78,0) NOT NULL,
    "winnersPayout" DECIMAL(78,0) NOT NULL,
    "fees" DECIMAL(78,0) NOT NULL,
    "houseDelta" DECIMAL(78,0) NOT NULL,
    "oracleReporter" TEXT,
    "resultReportedAt" TIMESTAMP(3),
    "reason" TEXT,
    "txHash" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("marketOnchainId")
);

-- CreateTable
CREATE TABLE "OracleReport" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "winningOutcome" INTEGER,
    "reporter" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "finalAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,

    CONSTRAINT "OracleReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainLog" (
    "id" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexedBlock" (
    "number" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,

    CONSTRAINT "IndexedBlock_pkey" PRIMARY KEY ("number")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "lastBlock" INTEGER NOT NULL,
    "reorgs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "params" JSONB NOT NULL,
    "txHash" TEXT,
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_ref_key" ON "Event"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Event_onchainId_key" ON "Event"("onchainId");

-- CreateIndex
CREATE INDEX "Event_startTime_idx" ON "Event"("startTime");

-- CreateIndex
CREATE UNIQUE INDEX "Market_ref_key" ON "Market"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "Market_onchainId_key" ON "Market"("onchainId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_questionId_key" ON "Market"("questionId");

-- CreateIndex
CREATE INDEX "Market_eventId_idx" ON "Market"("eventId");

-- CreateIndex
CREATE INDEX "Market_status_idx" ON "Market"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Outcome_marketId_index_key" ON "Outcome"("marketId", "index");

-- CreateIndex
CREATE INDEX "BetIndex_bettor_idx" ON "BetIndex"("bettor");

-- CreateIndex
CREATE INDEX "BetIndex_marketOnchainId_idx" ON "BetIndex"("marketOnchainId");

-- CreateIndex
CREATE INDEX "OddsHistory_marketId_createdAt_idx" ON "OddsHistory"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "OddsHistory_txHash_idx" ON "OddsHistory"("txHash");

-- CreateIndex
CREATE INDEX "Transaction_createdAt_idx" ON "Transaction"("createdAt");

-- CreateIndex
CREATE INDEX "OracleReport_questionId_idx" ON "OracleReport"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "OracleReport_txHash_logIndex_key" ON "OracleReport"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "ChainLog_blockNumber_idx" ON "ChainLog"("blockNumber");

-- CreateIndex
CREATE INDEX "ChainLog_eventName_idx" ON "ChainLog"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "ChainLog_txHash_logIndex_key" ON "ChainLog"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "AuthNonce_address_idx" ON "AuthNonce"("address");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetIndex" ADD CONSTRAINT "BetIndex_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetIndex" ADD CONSTRAINT "BetIndex_bettor_fkey" FOREIGN KEY ("bettor") REFERENCES "User"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OddsHistory" ADD CONSTRAINT "OddsHistory_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
