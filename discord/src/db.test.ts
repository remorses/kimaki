import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { getPrisma, closePrisma } from "./db.js"

describe("getPrisma", () => {
    test("creates sqlite file and migrates schema automatically", async () => {
        const prisma = await getPrisma()

        const session = await prisma.thread_sessions.create({
            data: { thread_id: "test-thread-123", session_id: "test-session-456" },
        })
        expect(session.thread_id).toBe("test-thread-123")
        expect(session.created_at).toBeInstanceOf(Date)

        const found = await prisma.thread_sessions.findUnique({
            where: { thread_id: session.thread_id },
        })
        expect(found?.session_id).toBe("test-session-456")

        // Cleanup test data
        await prisma.thread_sessions.delete({
            where: { thread_id: "test-thread-123" },
        })
    })
})
