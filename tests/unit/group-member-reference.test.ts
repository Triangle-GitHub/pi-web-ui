// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { insertGroupMember, referenceGroupMember, registerGroupMemberSink } from "../../web/src/group-member-reference";
import { groupMessageTargets } from "../../web/src/device-group-messages";
import {
	groupReferenceDestination,
	groupMemberDeletion,
	serializeGroupMemberReferences,
	updateGroupMemberReferences,
} from "../../web/src/group-member-reference";

it("keeps conversation identity through edits and rejects mixed destinations", () => {
	const member = { id: "bot", name: "Bot" };
	const ref = { start: 0, end: 4, member, conversationId: "original" };
	expect(groupReferenceDestination(updateGroupMemberReferences("@Bot", "@Bot follow up", [ref]))).toBe("original");
	expect(groupReferenceDestination(updateGroupMemberReferences("@Bot", "hello", [ref]))).toBeUndefined();
	expect(() => groupReferenceDestination([ref, { ...ref, conversationId: undefined }])).toThrow();
	expect(() => groupReferenceDestination([ref, { ...ref, conversationId: "other" }])).toThrow();
	expect(groupReferenceDestination([{ ...ref, conversationId: undefined }])).toBeUndefined();
});

it("queues references for the matching group and delivers once when its composer mounts", () => {
	const member = { id: "stable-bot", name: "Same name" };
	referenceGroupMember("destination", member);
	referenceGroupMember("destination", member);
	const wrong = vi.fn();
	const stopWrong = registerGroupMemberSink("other", wrong);
	expect(wrong).not.toHaveBeenCalled();
	const receive = vi.fn();
	const stop = registerGroupMemberSink("destination", receive);
	expect(receive).toHaveBeenCalledExactlyOnceWith(member);
	referenceGroupMember("destination", member);
	expect(receive).toHaveBeenCalledTimes(2);
	stop();
	stopWrong();
	const next = vi.fn();
	registerGroupMemberSink("destination", next)();
	expect(next).not.toHaveBeenCalled();
});

it("inserts at the cursor and routes duplicate names by stable ID without duplicating tokens", () => {
	const bots = [
		{ id: "a", name: "Bot" },
		{ id: "b", name: "Bot" },
	];
	const result = insertGroupMember("hello world", 5, bots[1]);
	expect(result.text).toBe("hello @Bot  world");
	const refs = [{ start: 6, end: 10, member: bots[1] }];
	const serialized = serializeGroupMemberReferences(result.text, refs);
	expect(groupMessageTargets(serialized.text, bots)).toEqual(["b"]);
	expect(serialized.targets).toEqual(["b"]);
	expect(groupMemberDeletion(result.text, 11, 11, "Backspace", refs)).toEqual({ start: 6, end: 11 });
	expect(groupMemberDeletion(result.text, 6, 6, "Delete", refs)).toEqual({ start: 6, end: 10 });
	expect(groupMemberDeletion(result.text, 8, 9, "Backspace", refs)).toEqual({ start: 6, end: 10 });
	expect(updateGroupMemberReferences(result.text, "!" + result.text, refs)[0].start).toBe(7);
	expect(updateGroupMemberReferences(result.text, result.text.replace("@Bot", "@Bo"), refs)).toEqual([]);
});
