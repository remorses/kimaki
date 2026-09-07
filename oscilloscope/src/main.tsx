// Server-rendered document shell for the interactive oscilloscope.
import { Spiceflow } from "spiceflow";
import { Head } from "spiceflow/react";
import { Instrument } from "./instrument.tsx";
import "./instrument.css";

export const app = new Spiceflow()
  .layout("/*", ({ children }) => (
    <html lang="en">
      <Head>
        <Head.Meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />
        <Head.Title>Analog Oscilloscope</Head.Title>
        <Head.Meta
          name="description"
          content="An interactive vintage oscilloscope with illuminated switches, a phosphor display, and a tunable three-dimensional signal."
        />
      </Head>
      <body>{children}</body>
    </html>
  ))
  .page("/", () => <Instrument />);

await app.listen(3000);
