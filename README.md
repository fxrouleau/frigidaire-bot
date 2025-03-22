# Frigidaire Bot
This is a bot that I've created for personal use on a discord server with friends. Currently, the only functionality is to 
replace a Twitter/X link and repost the message with a fixvx link instead. This is because, at the time, Twitter does not embed 
properly in discord. The downside is that there are 2 notification messages. The bot replaces the message with a webhook
message, utilising the user's avatar and name, to make it look like the user sent the message, as unfortunately discord
does not allow bots to edit other user's messages, not does it allow to intercept messages before they are sent.

## Docker Compose
If you want to just use the bot easily without downloading this repository, you can use the following docker-compose template:
```yaml
version: '3'
services:
  discord-bot:
    image: zergyhan/frigidaire-bot
    environment:
      - CLIENT_SECRET=YOUR_SECRET_HERE
```
Client secret can be gotten from the [discord developer portal](https://discord.com/developers/applications) under the bot section.
You will have to give the bot permissions to manage webhooks, read and send messages.
