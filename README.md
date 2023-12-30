# Frigidaire Bot
This is a bot that I use for my friends discord server. Currently the only functionality that it has it to 
delete a twitter / x link and post a fxtwitter link instead. This is because, at the time, twitter does not embed 
properly in discord. Downside is that if you ping someone, they get 'double' pinged, although the original message
gets deleted.

## Setting up
Made to run easily in docker with docker compose. Just add an environment variable called `CLIENT_SECRET` with the discord
bot's secret. Alternatively, you can add a .env file with `CLIENT_SECRET` and run it locally.

After adding it, you can run it with 
```shell
docker compose up -d
```

Alternatively, you can run it locally. First, you have to set up your local env.
```shell
yarn install --production
```
Then, you can run it.
```shell
yarn prod
```

Between the two, I highly recommend the docker compose route.
