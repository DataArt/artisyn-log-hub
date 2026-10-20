export const meta = {
  name: 'java-refactor',
  description: 'Add StringUtils.reverseWords to java-lib, then add its JUnit 5 test',
  phases: [
    { title: 'Implement' },
    { title: 'Test' },
  ],
}

phase('Implement')

const impl = await agent(
  'In this Maven project, edit `src/main/java/com/example/lib/StringUtils.java` and add a ' +
    '`public static String reverseWords(String input)` method that returns the words of `input` ' +
    '(split on whitespace) in reverse order, joined by single spaces. Return `input` unchanged when ' +
    'it is null or blank. Do not change any other file, do not run Maven and do not install anything. ' +
    'Reply with one line describing the change.',
  { phase: 'Implement', label: 'reverseWords' },
)

phase('Test')

const test = await agent(
  'In this Maven project, edit `src/test/java/com/example/lib/StringUtilsTest.java` and add JUnit 5 ' +
    'tests for `StringUtils.reverseWords`: a normal sentence, a single word, and null/blank input. ' +
    'Do not change any other file, do not run Maven and do not install anything. ' +
    'Reply with one line describing the change.',
  { phase: 'Test', label: 'reverseWords test' },
)

return { impl, test }
