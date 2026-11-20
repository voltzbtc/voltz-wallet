// Native module, absent in Jest.
export default {
  setString: jest.fn(),
  getString: jest.fn(async () => ''),
}
