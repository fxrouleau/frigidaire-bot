import { Events, Message } from "discord.js";
const twitterRepost = require("../events/twitterRepost");

describe("Twitter Repost Event", () => {
  it("should have the correct event name", () => {
    expect(twitterRepost.name).toBe(Events.MessageCreate);
  });

  it("should replace twitter.com with fixvx.com", async () => {
    const mockMessage = {
      content: "Check this out https://twitter.com/user/status/123456789",
      author: { globalName: "TestUser" },
      delete: jest.fn().mockResolvedValue(true),
      channel: {
        send: jest.fn().mockResolvedValue(true),
      },
    } as unknown as Message;

    await twitterRepost.execute(mockMessage);

    expect(mockMessage.delete).toHaveBeenCalled();
    expect(mockMessage.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("https://fixvx.com/user/status/123456789")
    );
  });

  it("should replace x.com with fixvx.com", async () => {
    const mockMessage = {
      content: "Check this out https://x.com/user/status/123456789",
      author: { globalName: "TestUser" },
      delete: jest.fn().mockResolvedValue(true),
      channel: {
        send: jest.fn().mockResolvedValue(true),
      },
    } as unknown as Message;

    await twitterRepost.execute(mockMessage);

    expect(mockMessage.delete).toHaveBeenCalled();
    expect(mockMessage.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("https://fixvx.com/user/status/123456789")
    );
  });

  it("should remove query parameters from URLs", async () => {
    const mockMessage = {
      content: "Check this out https://twitter.com/user/status/123456789?s=20",
      author: { globalName: "TestUser" },
      delete: jest.fn().mockResolvedValue(true),
      channel: {
        send: jest.fn().mockResolvedValue(true),
      },
    } as unknown as Message;

    await twitterRepost.execute(mockMessage);

    expect(mockMessage.delete).toHaveBeenCalled();
    expect(mockMessage.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("https://fixvx.com/user/status/123456789")
    );
  });
});
