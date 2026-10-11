// Synthetic installed driver: no vendor calls, credentials, or managed services.
export const interfaceVersion = 1;
let registrations = 0;
export function register(factory) {
  registrations++;
  factory('third-fixture', () => ({
    registrationCount: registrations,
    getName: () => 'third-fixture',
    getBinary: () => 'fixture-worker',
    getCapabilities: () => ({ modelPin: true }),
    buildSessionArgs: ({ model, prompt }) => ['--model', model, '--prompt', prompt],
    catalog: () => [{ id: 'synthetic-model', provider: 'synthetic-inference' }],
  }));
}
